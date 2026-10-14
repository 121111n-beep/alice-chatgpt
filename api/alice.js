const MAX_HISTORY_ITEMS = 4;
const MAX_HISTORY_TEXT = 100;

function readHistory(event) {
  const history = event?.state?.session?.h;

  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        (item[0] === "u" || item[0] === "a")
    )
    .map(([role, text]) => [
      role,
      String(text).trim().slice(0, MAX_HISTORY_TEXT)
    ])
    .filter(([, text]) => text)
    .slice(-MAX_HISTORY_ITEMS);
}

function makeSessionState(history) {
  return {
    h: history
      .map(([role, text]) => [
        role,
        String(text).trim().slice(0, MAX_HISTORY_TEXT)
      ])
      .filter(([, text]) => text)
      .slice(-MAX_HISTORY_ITEMS)
  };
}

function aliceResponse(event, text, sessionState = { h: [] }) {
  const answer = String(text).slice(0, 1000);

  return Response.json({
    version: event?.version || "1.0",
    response: {
      text: answer,
      tts: answer,
      end_session: false
    },
    session_state: sessionState
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

      return Response.json(
        {
          version: "1.0",
          response: {
            text: "Получен некорректный запрос.",
            tts: "Получен некорректный запрос.",
            end_session: false
          },
          session_state: { h: [] }
        },
        { status: 200 }
      );
    }

    console.log(
      `Alice session: ${event?.session?.session_id || "unknown"}`
    );

    const history = readHistory(event);
    const currentState = makeSessionState(history);

    const phrase = String(
      event?.request?.command ||
      event?.request?.original_utterance ||
      ""
    ).trim();

    if (!phrase) {
      return aliceResponse(
        event,
        "Привет! Это Пригожин Женя.",
        currentState
      );
    }

    const normalizedPhrase = phrase.toLowerCase();

    if (
      normalizedPhrase === "очисти историю" ||
      normalizedPhrase === "забудь контекст" ||
      normalizedPhrase === "начать заново"
    ) {
      return aliceResponse(event, "Контекст очищен.", { h: [] });
    }

    if (!process.env.GROQ_API_KEY) {
      console.error("GROQ_API_KEY is missing");

      return aliceResponse(
        event,
        "Ключ проебали, обнови VERCEL.",
        currentState
      );
    }

    const input = [
      ...history.map(([role, text]) => ({
        role: role === "u" ? "user" : "assistant",
        content: text
      })),
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
            reasoning: { effort: "low" },
            instructions:
              "Ты голосовой помощник. Отвечай по-русски, кратко и естественно. Учитывай предыдущие реплики из текущего разговора. Не используй Markdown. Ответ должен быть короче 600 символов. Отвечай без лишней воды в хамоватой манере",
            input,
            max_output_tokens: 256
          }),
          signal: AbortSignal.timeout(3200)
        }
      );

      if (!groqResponse.ok) {
        const details = await groqResponse.text();

        console.error(
          `Groq API error: ${groqResponse.status} ${details.slice(0, 500)}`
        );

        return aliceResponse(
          event,
          "Бляяяя, что-то я прослушал. Повтори по-братски.",
          currentState
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

        return aliceResponse(
          event,
          "Туплю, больше не могу отвечать",
          currentState
        );
      }

      const nextState = makeSessionState([
        ...history,
        ["u", phrase],
        ["a", answer]
      ]);

      console.log("Alice response completed");

      return aliceResponse(event, answer, nextState);
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Groq request failed"
      );

      return aliceResponse(
        event,
        "Я заебался. Потом поговорим.",
        currentState
      );
    }
  }
};
