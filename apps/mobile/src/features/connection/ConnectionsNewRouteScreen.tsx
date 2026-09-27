import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ExpoCrypto from "expo-crypto";
import * as ExpoLinking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import { AuthGitHubMobileFinishResult, AuthSessionState } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ConnectionFormField } from "./ConnectionFormField";
import { ConnectionSheetButton } from "./ConnectionSheetButton";
import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { randomHex } from "../../lib/uuid";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const {
    connectionPairingUrl,
    onChangeConnectionPairingUrl,
    onConnectPress,
    pairingConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const params = route.params ?? {};
  // Deep-link prefill exists for development automation only. A production
  // link must not arrive with attacker-chosen host and token already filled.
  const routePairingUrl = __DEV__ ? (params.pairingUrl?.trim() ?? "") : "";
  const shouldAutoConnect =
    __DEV__ &&
    routePairingUrl.length > 0 &&
    (params.autoConnect === "1" || params.autoConnect === "true");
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [githubError, setGithubError] = useState("");
  const [showScanner, setShowScanner] = useState(params.mode === "scan_qr");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerLocked, setScannerLocked] = useState(false);
  const attemptedAutoConnectRef = useRef<string | null>(null);

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const connectDisabled = isSubmitting || hostInput.trim().length === 0;

  useEffect(() => {
    const { host, code } = parsePairingUrl(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (routePairingUrl.length === 0) {
      return;
    }

    const { host, code } = parsePairingUrl(routePairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [routePairingUrl]);

  useEffect(() => {
    if (pairingConnectionError) {
      setIsSubmitting(false);
    }
  }, [pairingConnectionError]);

  const handleHostChange = useCallback((value: string) => {
    setHostInput(value);
  }, []);

  const handleCodeChange = useCallback((value: string) => {
    setCodeInput(value);
  }, []);

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    if (permission.canAskAgain) {
      Alert.alert(
        "Camera access needed",
        "Allow camera access to scan an environment pairing QR code.",
      );
      return;
    }

    Alert.alert(
      "Camera access needed",
      "Camera access was denied for this app. Open Settings to enable it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, [cameraPermission?.granted, requestCameraPermission]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerLocked(false);
  }, []);

  const handleQrScan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked) {
        return;
      }

      setScannerLocked(true);

      try {
        const pairingUrl = extractPairingUrlFromQrPayload(data);
        const { host, code } = parsePairingUrl(pairingUrl);
        setHostInput(host);
        setCodeInput(code);
        onChangeConnectionPairingUrl(pairingUrl);
        setShowScanner(false);
      } catch (error) {
        Alert.alert(
          "Invalid QR code",
          error instanceof Error ? error.message : "Scanned QR code was not recognized.",
        );
      } finally {
        setTimeout(() => {
          setScannerLocked(false);
        }, 600);
      }
    },
    [onChangeConnectionPairingUrl, scannerLocked],
  );

  const connectAndClose = useCallback(
    async (pairingUrl: string, replaceWithHome: boolean) => {
      setIsSubmitting(true);
      onChangeConnectionPairingUrl(pairingUrl);
      try {
        const result = await onConnectPress(pairingUrl);
        if (AsyncResult.isSuccess(result)) {
          if (replaceWithHome || !navigation.canGoBack()) {
            navigation.dispatch(StackActions.replace("Home"));
          } else {
            navigation.goBack();
          }
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [navigation, onChangeConnectionPairingUrl, onConnectPress],
  );

  const handleSubmit = useCallback(async () => {
    await connectAndClose(buildPairingUrl(hostInput, codeInput), false);
  }, [codeInput, connectAndClose, hostInput]);

  const handleGitHubSignIn = useCallback(async () => {
    setIsSubmitting(true);
    setGithubError("");
    try {
      const host = parsePairingUrl(buildPairingUrl(hostInput, "")).host;
      const origin = new URL(host).origin;
      const response = await fetch(`${origin}/api/auth/session`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Could not reach this environment.");
      const session = Schema.decodeUnknownSync(AuthSessionState)(await response.json());
      if (!session.auth.bootstrapMethods.includes("github-oauth")) {
        throw new Error("GitHub sign-in is not enabled for this environment.");
      }

      const nonce = randomHex(32);
      const verifier = randomHex(32);
      const challenge = await ExpoCrypto.digestStringAsync(
        ExpoCrypto.CryptoDigestAlgorithm.SHA256,
        verifier,
      );
      const mobileRedirect = ExpoLinking.createURL("github-auth");
      const signInUrl = new URL("/api/auth/github/start", origin);
      signInUrl.searchParams.set("mobile_redirect", mobileRedirect);
      signInUrl.searchParams.set("mobile_nonce", nonce);
      signInUrl.searchParams.set("mobile_challenge", challenge);
      const result = await WebBrowser.openAuthSessionAsync(signInUrl.toString(), mobileRedirect);
      if (result.type !== "success") return;

      const callback = new URL(result.url);
      const expected = new URL(mobileRedirect);
      if (
        callback.protocol !== expected.protocol ||
        callback.host !== expected.host ||
        callback.pathname !== expected.pathname ||
        callback.searchParams.get("nonce") !== nonce ||
        callback.searchParams.get("host") !== origin
      ) {
        throw new Error("GitHub sign-in response could not be verified.");
      }
      const flow = callback.searchParams.get("flow");
      if (!flow) throw new Error("GitHub sign-in did not return a completed flow.");
      const finish = await fetch(`${origin}/api/auth/github/mobile/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow, verifier }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!finish.ok) throw new Error("GitHub sign-in could not establish a T3 session.");
      const completed = Schema.decodeUnknownSync(AuthGitHubMobileFinishResult)(await finish.json());
      await connectAndClose(buildPairingUrl(origin, completed.credential), false);
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "GitHub sign-in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }, [connectAndClose, hostInput]);

  useEffect(() => {
    if (!shouldAutoConnect || attemptedAutoConnectRef.current === routePairingUrl) {
      return;
    }

    attemptedAutoConnectRef.current = routePairingUrl;
    void connectAndClose(routePairingUrl, true);
  }, [connectAndClose, routePairingUrl, shouldAutoConnect]);

  return (
    <SettingsScreen
      formSheet={routeName === "ConnectionsNew"}
      title={showScanner ? "Scan QR Code" : "Add Environment"}
      actions={[
        {
          accessibilityLabel: showScanner ? "Close scanner" : "Scan QR code",
          icon: showScanner ? "xmark" : Platform.OS === "ios" ? "qrcode.viewfinder" : "camera",
          tintColor: headerIconColor,
          onPress: () => {
            if (showScanner) {
              closeScanner();
            } else {
              void openScanner();
            }
          },
        },
      ]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <View collapsable={false} className="gap-5">
          {showScanner ? (
            cameraPermission?.granted ? (
              <View className="overflow-hidden rounded-[24px] border-continuous">
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleQrScan}
                  style={{ aspectRatio: 1, width: "100%" }}
                />
              </View>
            ) : (
              <View className="items-center gap-3 rounded-[24px] border-continuous bg-card px-5 py-8">
                <Text className="text-center text-sm leading-normal text-foreground-muted">
                  Camera permission is required to scan a QR code.
                </Text>
                <ConnectionSheetButton
                  compact
                  icon="camera"
                  label="Allow camera"
                  tone="secondary"
                  onPress={() => {
                    void openScanner();
                  }}
                />
              </View>
            )
          ) : (
            <View collapsable={false} className="gap-4 rounded-[24px] bg-card p-4">
              <ConnectionFormField
                label="Host"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="192.168.1.100:8080"
                value={hostInput}
                onChangeText={handleHostChange}
              />

              <ConnectionFormField
                label="Pairing code"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="abc-123-xyz"
                value={codeInput}
                onChangeText={handleCodeChange}
              />

              {pairingConnectionError ? <ErrorBanner message={pairingConnectionError} /> : null}

              {githubError ? <ErrorBanner message={githubError} /> : null}

              <ConnectionSheetButton
                icon="person.crop.circle"
                label="Continue with GitHub"
                disabled={connectDisabled}
                tone="secondary"
                onPress={() => {
                  void handleGitHubSignIn();
                }}
              />

              <View className="android:flex-row android:justify-end">
                <ConnectionSheetButton
                  icon="plus"
                  label={isSubmitting ? "Pairing..." : "Add environment"}
                  disabled={connectDisabled}
                  tone="primary"
                  onPress={() => {
                    void handleSubmit();
                  }}
                />
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
