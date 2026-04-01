// Supabase Edge Function: lookup
// Receives a Japanese word from the authenticated frontend, calls the
// Anthropic API using a secret key stored in Supabase environment variables,
// and returns the structured JSON result.
//
// Deploy with:
//   supabase functions deploy lookup
//
// Set the secret before deploying:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

// Allow requests from any origin so the Vercel-hosted frontend can call this.
// Tighten this to your Vercel domain once you know it, e.g.:
//   'Access-Control-Allow-Origin': 'https://nihong-ai.vercel.app'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM_PROMPT = `You are a Japanese language expert. When the user provides a Japanese word or phrase in ANY form (dictionary form, て-form, polite form, negative form, casual speech, romaji, etc.), analyze it and return a JSON object with the following structure. Respond with ONLY the JSON, no markdown, no extra text.

{
  "input_form": "the exact form the user entered",
  "dictionary_form": "辞書形 (plain dictionary form)",
  "kanji": "kanji representation (same as dictionary_form if it already is kanji, or kanji version if user entered kana)",
  "hiragana": "full hiragana reading of the dictionary form",
  "romaji": "romaji of the dictionary form",
  "meaning": "concise English meaning, e.g. 'to drink; to swallow'",
  "pos": "one of: verb, noun, adjective, adverb, other",
  "verb_type": "for verbs only: 'ru-verb (Group 2)', 'u-verb (Group 1)', or 'irregular'. null for non-verbs.",
  "adj_type": "for adjectives only: 'i-adjective' or 'na-adjective'. null otherwise.",
  "tags": ["JLPT N5", "JLPT N4", etc — include JLPT level if known],
  "forms": [
    { "label": "辞書形 (Dictionary)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "ます形 (Polite Present)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "ない形 (Negative)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "ません形 (Polite Negative)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "た形 (Past)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "ました形 (Polite Past)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "なかった形 (Past Negative)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "て形 (Te-form)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "可能形 (Potential)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "意向形 (Volitional)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "受身形 (Passive)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "使役形 (Causative)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "条件形ば (Conditional -ba)", "japanese": "…", "hiragana": "…", "romaji": "…" },
    { "label": "条件形たら (Conditional -tara)", "japanese": "…", "hiragana": "…", "romaji": "…" }
  ],
  "example_sentences": [
    { "japanese": "…", "hiragana": "…", "english": "…" },
    { "japanese": "…", "hiragana": "…", "english": "…" },
    { "japanese": "…", "hiragana": "…", "english": "…" }
  ],
  "notes": "any important usage notes, nuances, or common mistakes. Keep brief."
}

For non-verbs, "forms" should contain relevant inflections (e.g. for adjectives: plain/polite/negative/past forms; for nouns: with particles). Keep "forms" non-empty and useful for any part of speech.`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  // Only POST is accepted
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // Verify the caller is a signed-in Supabase user
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  // Parse and validate the request body
  let word: string
  try {
    const body = await req.json()
    word = typeof body?.word === 'string' ? body.word.trim() : ''
  } catch {
    return json({ error: 'Invalid request body' }, 400)
  }

  if (!word)           return json({ error: 'word is required' }, 400)
  if (word.length > 200) return json({ error: 'word is too long (max 200 characters)' }, 400)

  // Call Anthropic — the API key is a server-side secret, never sent to the browser
  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'Server is missing ANTHROPIC_API_KEY — contact the admin.' }, 500)
  }

  let anthropicRes: Response
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1800,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: word }],
      }),
    })
  } catch (e) {
    return json({ error: 'Failed to reach Anthropic API' }, 502)
  }

  if (!anthropicRes.ok) {
    const err = await anthropicRes.json().catch(() => ({}))
    return json({ error: err?.error?.message ?? `Anthropic error ${anthropicRes.status}` }, 502)
  }

  const data = await anthropicRes.json()
  const raw = (data?.content?.[0]?.text ?? '').trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')

  let result: unknown
  try {
    result = JSON.parse(raw)
  } catch {
    return json({ error: 'AI returned invalid JSON — please try again.' }, 502)
  }

  return json(result)
})
