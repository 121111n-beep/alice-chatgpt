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
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let event;

    try {
      event = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const phrase = String(
      event?.request?.command ||
      event?.request?.original_utterance ||
      ""
    ).trim();

    if (!phrase) {
      return aliceResponse(event, "Привет! Задайте мне вопрос.");
    }

    if (!process.env.OPENAI_API_KEY) {
      return aliceResponse(event, "Ключ OpenAI пока не настроен.");
    }

    try {
      const openaiResponse = await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-6-luna",
            reasoning: {
              effort: "none"
            },
            instructions:
              "Ты голосовой помощник. Отвечай по-русски, кратко и естественно. Не используй Markdown. Ответ должен быть короче 600 символов.",
            input: phrase,
            max_output_tokens: 160,
            store: false
          }),
          signal: AbortSignal.timeout(3200)
        }
      );

      if (!openaiResponse.ok) {
        console.error(`OpenAI API error: ${openaiResponse.status}`);
        return aliceResponse(
          event,
          "Не удалось получить ответ. Попробуйте ещё раз."
        );
      }

      const data = await openaiResponse.json();

      const answer = (data.output || [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      return aliceResponse(
        event,
        answer || "Не удалось сформировать ответ."
      );
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "OpenAI request failed"
      );

      return aliceResponse(
        event,
        "Ответ занял слишком много времени. Попробуйте ещё раз."
      );
    }
  }
};
