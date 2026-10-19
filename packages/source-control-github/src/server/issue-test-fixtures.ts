export const templateEntry = (name: string, text: string) => ({
  name,
  object: { __typename: "Blob", text },
});

export function issueTarget(host = "github.com") {
  return { cwd: "/w", host, scope: "acme/web", key: "42" };
}
