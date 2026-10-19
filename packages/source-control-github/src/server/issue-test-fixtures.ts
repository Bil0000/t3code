export const templateEntry = (name: string, text: string) => ({
  name,
  object: { __typename: "Blob", text },
});
