import type { Theme } from "./types"

const systemui = require("expo-system-ui")

/** Only does anything if the app has installed expo-system-ui. */
export const setSystemUIBackgroundColor = (color: string) => {
  if (systemui) {
    systemui.setBackgroundColorAsync(color)
  }
}

/** Set the app's native background color to match the theme. */
export const setImperativeTheming = (theme: Theme) => {
  setSystemUIBackgroundColor(theme.colors.background)
}
