import type { ReactNode } from "react";

export function ComposerContextLabel(props: { readonly children: ReactNode }) {
  return (
    <span
      data-composer-label
      className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
    >
      <span
        data-composer-label-motion
        className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
      >
        {props.children}
      </span>
    </span>
  );
}
