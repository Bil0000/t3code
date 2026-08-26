# Side questions

Type `/btw` followed by a question to ask about the current thread without interrupting the agent.
For example:

```text
/btw Why did we choose SQLite here?
```

T3 Code sends the question and the completed thread context to a separate, tool-free provider
request. The active turn keeps running. The side question does not enter the thread transcript or
change what the main agent is doing.

The answer appears in a card above the composer. Close the card when you are done. Type `/btw`
without a question to reopen the latest side-question card for that thread in the current app view.

Side questions accept text only. They use the model selected for the thread and work with every
provider that T3 Code supports.
