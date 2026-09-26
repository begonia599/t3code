import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useMobileT } from "../../../i18n";

export function SettingsSection(props: {
  readonly title?: string;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  const t = useMobileT();
  return (
    <View className="gap-2">
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3">
          <Text
            className={
              Platform.OS === "android"
                ? "px-4 text-sm font-t3-medium text-primary-text"
                : "px-2 text-sm font-t3-medium text-foreground-muted"
            }
          >
            {t(props.title)}
          </Text>
          {props.trailing}
        </View>
      ) : null}
      <View
        className={
          Platform.OS === "android"
            ? "overflow-hidden rounded-[28px] bg-grouped-card"
            : "overflow-hidden rounded-[24px] border-continuous bg-grouped-card"
        }
      >
        {props.children}
      </View>
    </View>
  );
}
