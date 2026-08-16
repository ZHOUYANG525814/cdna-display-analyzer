export interface DeviceSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  userAgentDataMobile?: boolean;
}

export function readDeviceSignals(navigatorLike: Navigator = navigator): DeviceSignals {
  const withClientHints = navigatorLike as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  return {
    userAgent: navigatorLike.userAgent ?? "",
    platform: navigatorLike.platform ?? "",
    maxTouchPoints: navigatorLike.maxTouchPoints ?? 0,
    ...(typeof withClientHints.userAgentData?.mobile === "boolean"
      ? { userAgentDataMobile: withClientHints.userAgentData.mobile }
      : {}),
  };
}

/** Device-class gate only. A narrow desktop window remains supported. */
export function isMobileOrTablet(signals: DeviceSignals): boolean {
  if (signals.userAgentDataMobile === true) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(signals.userAgent)) return true;
  return signals.platform === "MacIntel" && signals.maxTouchPoints > 1;
}
