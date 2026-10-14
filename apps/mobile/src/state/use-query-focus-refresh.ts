import { RegistryContext } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import type { AsyncResult, Atom } from "effect/reactivity";
import { use, useCallback, useRef } from "react";

export function useQueryFocusRefresh<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  const registry = use(RegistryContext);
  const focusedAtom = useRef<typeof atom | null>(null);
  useFocusEffect(
    useCallback(() => {
      const firstFocus = focusedAtom.current !== atom;
      focusedAtom.current = atom;
      const result = registry.get(atom);
      if (!firstFocus || (result._tag !== "Initial" && !result.waiting)) registry.refresh(atom);
    }, [atom, registry]),
  );
}
