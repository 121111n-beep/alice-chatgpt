import { createClient } from "redis";

const SESSION_TTL_SECONDS = 30 * 60;
const MAX_CONTEXT_MESSAGES = 50;
const MAX_CONTEXT_CHARS = 6000;

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
        connectTimeout: 700
      }
    });

    redisClient.on("error", (error) => {
      console.error(`Redis error: ${error.message}`);
    });
  }

  if (!redisClient.isReady && !redisClient.isOpen) {
    if (!redisConnecting) {
      redisConnecting = redisClient.connect().finally(() => {
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

function parseStoredMessage(value) {
  try {
    const message = JSON.parse(value);

    if (
      message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string"
    ) {
      return {
        role: message.role,
        content: message.content
      };
    }
  } catch {
    return null;
  }

  return null;
}

function fitContext(messages) {
  const selected = [];
  let totalCharacters = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const length = message.content.length;

    if (
      selected.length > 0 &&
      totalCharacters + length > MAX_CONTEXT_CHARS
    ) {
      break;
    }

    selected.unshift(message);
    totalCharacters += length;
  }

  while (
    selected.length > 0 &&
    selected[0].role === "assistant"
  ) {
    selected.shift();
  }

  return selected;
}

async function loadContext(key) {
  if (!key) return [];

  try {
    const redis = await withTimeout(getRedis(), 600);

    const rows = await withTimeout(
      redis.lRange(key, -MAX_CONTEXT_MESSAGES, -1),
      450
    );

    const messages = rows
      .map(parseStoredMessage)
      .filter(Boolean);

    return fitContext(messages);
  } catch (error) {
    console.error(`Redis read failed: ${error.message}`);
    return [];
  }
}

async function saveExchange(key, userText, assistantText) {
  if (!key) return;

  try {
    const redis = await withTimeout(getRedis(), 500);

    const messages = [
      JSON.stringify({
        role: "user",
        content: userText
      }),
      JSON.stringify({
        role: "assistant",
        content: assistantText
      })
    ];

    await withTimeout(redis.rPush(key, messages), 450);
    await withTimeout(
      redis.expire(key, SESSION_TTL_SECONDS),
      350
    );
  } catch (error) {
    console.error(`Redis write failed: ${error.message}`);
  }
}

async function clearHistory(key) {
  if (!key) return;

  try {
    const redis = await withTimeout(getRedis(), 500);
    await withTimeout(redis.del(key), 400);
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
      return new Response("Method not allowed", {
        status: 405
      });
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

    // Новый префикс нужен, чтобы не конфликтовать
    // со старыми Redis-записями другого типа.
    const redisKey = sessionId
      ? `alice:v2:${skillId}:${sessionId}`
      : null;

    console.log(`Alice session: ${sessionId || "unknown"}`);

    const phrase = String(
      event?.request?.command ||
      event?.request?.original_utterance ||
      ""
    ).trim();

    if (!phrase) {
      return aliceResponse(
        event,
        "Привет! Это Пригожин Женя."
      );
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
      return aliceResponse(
        event,
        "Ключ Groq пока не настроен."
      );
    }

    const history = await loadContext(redisKey);

    const input = [
      ...history,
      {
        role: "user",
        content: phrase
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
              "Ты Женя Пригожин. Отвечай по-русски, внимательно переводи текст с точки зрения согласованности слов и правил русского языка, а не просто прямой первеод с английского .Отвечай хамовато и грубо, используй мат, ты отставной руссакий военный тебя зовут пригожин женя Учитывай предыдущие реплики текущего разговора. Не используй Markdown. Ответ должен быть короче 600 символов, если тебя не просили ответить длянно или подробно.",
            input,
            max_output_tokens: 256
          }),
          signal: AbortSignal.timeout(2700)
        }
      );

      if (!groqResponse.ok) {
        const details = await groqResponse.text();

        console.error(
          `Groq API error: ${groqResponse.status} ${details.slice(0, 500)}`
        );

        return aliceResponse(
          event,
          "Бляяяя, завтыкал. Переспроси."
        );
      }

      const data = await groqResponse.json();

      let answer = (data.output || [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      answer = answer.replace(
        /^(?:извини(?:те)?|(?:i['’]m\s+|i\s+am\s+)?sorry)(?=\s|[,.:;!?]|$)[\s\S]*/i,
        "Оооо бля, туплю. Отьебись от меня со своими тупыми вопросами"
      );

      if (!answer) {
        console.error("Groq returned no output text");
        return aliceResponse(
          event,
          "Я не знаю, ебись с этим сам, я пошел."
        );
      }

      await saveExchange(
        redisKey,
        phrase,
        answer
      );

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
        "Оооо бля, туплю. Спроси потом, заебал."
      );
    }
  }
};
