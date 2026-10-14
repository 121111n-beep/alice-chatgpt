import { createClient } from "redis";

const HISTORY_LIMIT = 6;
const TEXT_LIMIT = 500;
const SESSION_TTL_SECONDS = 30 * 60;

let redisClient;
let redisConnecting;

async function getRedis() {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is missing");
  }

  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        connectTimeout: 800
      }
    });

    redisClient.on("error", (error) => {
      console.error(`Redis error: ${error.message}`);
    });
  }

  if (!redisClient.isReady && !redisClient.isOpen) {
    if (!redisConnecting) {
      redisConnecting = redisClient
        .connect()
        .finally(() => {
          redisConnecting = null;
        });
    }

    await redisConnecting;
  }

  return redisClient;
}

function withTimeout(promise, milliseconds) {
  let timeout;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Operation timed out")),
        milliseconds
      );
    })
  ]).finally(() => clearTimeout(timeout));
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
    )
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, TEXT_LIMIT)
    }))
    .filter((item) => item.content)
    .slice(-HISTORY_LIMIT);
}

async function loadHistory(key) {
  if (!key) return [];

  try {
    const redis = await withTimeout(getRedis(), 700);
    const saved = await withTimeout(redis.get(key), 500);

    if (!saved) return [];

    return normalizeHistory(JSON.parse(saved));
  } catch (error) {
    console.error(`Redis read failed: ${error.message}`);
    return [];
  }
}

async function saveHistory(key, history) {
  if (!key) return;

  try {
    const redis = await withTimeout(getRedis(), 500);

    await withTimeout(
      redis.set(
        key,
        JSON.stringify(normalizeHistory(history)),
        { EX: SESSION_TTL_SECONDS }
      ),
      500
    );
  } catch (error) {
    console.error(`Redis write failed: ${error.message}`);
  }
}

async function clearHistory(key) {
  if (!key) return;

  try {
    const redis = await withTimeout(getRedis(), 500);
    await withTimeout(redis.del(key), 500);
  } catch (error) {
    console.error(`Redis delete failed: ${error.message}`);
  }
}

function aliceResponse(event, text) {
  const answer = String(text).slice(0, 1000);

  return Response.json({
    version: event?.version || "1.0",
    response: {
      text: answer,
      tts: answer,
      end_session: false
    }
  });
}

export default {
  async fetch(request) {
    console.log("Alice webhook invoked");

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let event;

    try {
      event = await request.json();
    } catch {
      console.error("Invalid JSON received");

      return Response.json({
        version: "1.0",
        response: {
          text: "Получен некорректный запрос.",
          tts: "Получен некорректный запрос.",
          end_session: false
        }
      });
    }

    const sessionId = event?.session?.session_id;
    const skillId = event?.session?.skill_id || "skill";
    const redisKey = sessionId
      ? `alice:${skillId}:${sessionId}`
      : null;

    console.log(`Alice session: ${sessionId || "unknown"}`);

    const phrase = String(
      event?.request?.command ||
      event?.request?.original_utterance ||
      ""
    ).trim();

    if (!phrase) {
      return aliceResponse(event, "Привет! Это Пригожин Женя.");
    }

    const normalizedPhrase = phrase.toLowerCase();

    if (
      normalizedPhrase === "очисти историю" ||
      normalizedPhrase === "забудь контекст" ||
      normalizedPhrase === "начать заново"
    ) {
      await clearHistory(redisKey);
      return aliceResponse(event, "Контекст очищен.");
    }

    if (!process.env.GROQ_API_KEY) {
      console.error("GROQ_API_KEY is missing");
      return aliceResponse(event, "Ключ Groq пока не настроен.");
    }

    const history = await loadHistory(redisKey);

    const input = [
      ...history,
      {
        role: "user",
        content: phrase.slice(0, TEXT_LIMIT)
      }
    ];

    try {
      const groqResponse = await fetch(
        "https://api.groq.com/openai/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-120b",
            reasoning: {
              effort: "low"
            },
            instructions:
              "Ты голосовой помощник. Отвечай по-русски, кратко и естественно. Учитывай предыдущие реплики текущего разговора. Не используй Markdown. Ответ должен быть короче 600 символов.",
            input,
            max_output_tokens: 256
          }),
          signal: AbortSignal.timeout(2800)
        }
      );

      if (!groqResponse.ok) {
        const details = await groqResponse.text();

        console.error(
          `Groq API error: ${groqResponse.status} ${details.slice(0, 500)}`
        );

        return aliceResponse(
          event,
          "Не удалось получить ответ. Попробуйте ещё раз."
        );
      }

      const data = await groqResponse.json();

      const answer = (data.output || [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      if (!answer) {
        console.error("Groq returned no output text");
        return aliceResponse(event, "Не удалось сформировать ответ.");
      }

      await saveHistory(redisKey, [
        ...history,
        {
          role: "user",
          content: phrase
        },
        {
          role: "assistant",
          content: answer
        }
      ]);

      console.log("Alice response completed");
      return aliceResponse(event, answer);
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "Groq request failed"
      );

      return aliceResponse(
        event,
        "Ответ занял слишком много времени. Попробуйте ещё раз."
      );
    }
  }
};
