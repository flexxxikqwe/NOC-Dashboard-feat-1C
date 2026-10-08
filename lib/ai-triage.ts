import { GoogleGenAI } from '@google/genai';
import db from '@/lib/db';

export interface TriageResult {
  diagnosis: string | null;
  actions: string | null;
}

const SYSTEM_PROMPT = `Ты — Senior инженер технической поддержки розничных систем на 1С:Предприятие 8.3 и кассового оборудования. Проанализируй входящий технический лог ошибки. Верни СТРОГО валидный JSON без markdown-разметки со структурой: {"diagnosis": "Суть сбоя простыми словами (1 строка)", "actions": "1. Первый шаг в AnyDesk\\n2. Второй шаг\\n3. Третий шаг"}`;

/**
 * Анализирует ошибку 1С через Gemini Flash API с автоматическим кэшированием в SQLite по error_hash
 * и обеспечением Graceful Degradation (при отсутствии ключа или сетевом сбое).
 *
 * @param errorType Тип ошибки или имя события
 * @param rawError Сырой текст ошибки 1С / оборудования
 * @param errorHash Хеш-сигнатура ошибки
 */
export async function triageIncident(
  errorType: string,
  rawError: string,
  errorHash: string
): Promise<TriageResult> {
  // ШАГ А: Проверка локального кэша в SQLite (0 мс, 0 токенов)
  try {
    const cachedRow = db
      .prepare(`
        SELECT ai_diagnosis, ai_actions 
        FROM incidents 
        WHERE error_hash = ? AND ai_diagnosis IS NOT NULL 
        LIMIT 1
      `)
      .get(errorHash) as { ai_diagnosis: string; ai_actions: string | null } | undefined;

    if (cachedRow?.ai_diagnosis) {
      return {
        diagnosis: cachedRow.ai_diagnosis,
        actions: cachedRow.ai_actions ?? null,
      };
    }
  } catch (cacheErr) {
    console.warn('[AI-TRIAGE] Cache lookup warning:', cacheErr);
  }

  // ШАГ Б: Проверка наличия API-ключа
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '') {
    return { diagnosis: null, actions: null };
  }

  // ШАГ В: Обращение к Gemini Flash API с жестким таймаутом и Graceful Degradation
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const promptText = `Тип ошибки: ${errorType}\nТекст ошибки: ${rawError}`;

    // Защита от зависания сети: таймаут 5 секунд
    const triagePromise = ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: promptText,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI-Triage request timed out (5s)')), 5000)
    );

    const response = await Promise.race([triagePromise, timeoutPromise]);
    const rawText = response.text ? response.text.trim() : '';

    if (!rawText) {
      return { diagnosis: null, actions: null };
    }

    // Очистка от возможных markdown-оберток ```json ... ```
    const cleanedText = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleanedText) as { diagnosis?: string; actions?: string };

    return {
      diagnosis: parsed.diagnosis ? String(parsed.diagnosis).trim() : null,
      actions: parsed.actions ? String(parsed.actions).trim() : null,
    };
  } catch (error) {
    // SRE-принцип Graceful Degradation: подавляем сбой без прерывания запроса
    console.warn('[AI-TRIAGE WARNING] Gemini triage failed gracefully:', error instanceof Error ? error.message : error);
    return { diagnosis: null, actions: null };
  }
}
