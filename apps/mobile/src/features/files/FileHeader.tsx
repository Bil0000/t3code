import { AppBar } from "../../components/ui/AppBar";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

export interface FileHeaderAction {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly inline: boolean;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => unknown;
}

export function FileHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly iconColor: string;
  readonly activeMode: string;
  readonly fileInspectorSupported?: boolean;
  readonly onBack: () => void;
  readonly onReturnToThread?: () => void;
  readonly actions: ReadonlyArray<FileHeaderAction>;
}) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const modes = props.actions.filter(({ inline }) => inline);
  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBack={props.onBack}
      hideBottomBorder
      options={{ headerTintColor: props.iconColor, headerTitle: props.title }}
      backInSplitView={
        props.fileInspectorSupported
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={
        props.fileInspectorSupported
          ? [
              {
                accessibilityLabel: panes.auxiliaryPaneVisible
                  ? "Hide file navigator"
                  : "Show file navigator",
                icon: "sidebar.right",
                selected: panes.auxiliaryPaneVisible,
                onPress: toggleAuxiliaryPane,
              },
            ]
          : undefined
      }
      menus={[
        {
          title: "File actions",
          icon: "ellipsis",
          separateBackground: false,
          items: [
            ...(modes.length > 0
              ? [
                  {
                    id: "modes",
                    inline: true,
                    items: modes.map((action) => ({
                      ...action,
                      selected: action.id === props.activeMode,
                    })),
                  },
                ]
              : []),
            ...props.actions.filter(({ inline }) => !inline),
          ],
        },
      ]}
    />
  );
}
