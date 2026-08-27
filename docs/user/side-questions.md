# Side questions

Type `/btw` followed by a question to ask about the current thread without interrupting the agent.
For example:

```text
/btw Why did we choose SQLite here?
```

T3 Code sends the question and the completed thread context to a separate, restricted provider
request. The active turn keeps running. The side question does not enter the thread transcript or
change what the main agent is doing.

Matching questions from connected clients share one request only when the current thread context and
prior side-conversation context also match. Different questions or contexts get separate answers.

On web and desktop, the side conversation opens in the right panel. Minimize it to keep a compact
strip above the composer, or close it to hide it. On mobile, the same conversation appears in a card
above the composer and can also be minimized.

Ask follow-up questions from the side conversation. T3 Code includes its earlier successful questions
and answers so the side agent can continue the same topic without steering the main agent. Type
`/btw` without a question to reopen the latest side conversation for that thread in the current app
view.

Use the model and reasoning controls in the side composer to change how the next side question runs.
This choice applies only to the side conversation. Use Stop to end an answer without stopping the
main agent. If another connected client is waiting for the same shared answer, its request continues.

Side questions are unavailable while the agent is waiting for required user input.

Side questions accept text only. They start with the model selected for the thread and work with every
provider that T3 Code supports.
