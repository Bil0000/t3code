import { useMemo } from "react";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { IssuesScreen } from "../issues/IssuesScreen";
import { WORKSPACE_TAB_PRESENTATION } from "./workspace-tabs-state";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation } from "./AndroidWorkspaceNavigation";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const context = useMemo(
    () => ({
      ...workspace,
      bottomClearance: workspace.state.selectedTab === "threads" ? fabClearance + 16 : 16,
    }),
    [workspace, fabClearance],
  );

  if (layout.usesSplitView) {
    return workspace.state.selectedTab === "threads" ? (
      <HomeRouteScreen />
    ) : (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader
          title={WORKSPACE_TAB_PRESENTATION[workspace.state.selectedTab].title}
        />
        <View className="flex-1 items-center justify-center px-10">
          <EmptyState
            title={
              workspace.state.selectedTab === "issues" ? "Select an issue" : "Select a pull request"
            }
            detail={
              workspace.state.selectedTab === "issues"
                ? "Choose an issue from the sidebar to read it."
                : "Choose a pull request from the sidebar to review it."
            }
            variant="plain"
          />
        </View>
      </>
    );
  }

  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <SafeAreaInsetsContext value={{ ...insets, bottom: 0 }}>
          <View className="flex-1">
            {workspace.state.selectedTab === "threads" ? (
              <HomeRouteScreen />
            ) : (
              <>
                <PullRequestToolbar />
                <ScreenContent>
                  {workspace.state.selectedTab === "pullRequests" ? (
                    <PullRequestsScreen />
                  ) : (
                    <IssuesScreen />
                  )}
                </ScreenContent>
              </>
            )}
          </View>
        </SafeAreaInsetsContext>
        <AndroidWorkspaceNavigation />
      </View>
    </WorkspaceTabsContext>
  );
}
