// we always make sure 'react-native' gets included first
// eslint-disable-next-line no-restricted-imports
import * as ReactNative from "react-native"

import mockFile from "./mockFile"

jest.doMock("react-native", () => {
  // Extend ReactNative
  return Object.setPrototypeOf(
    {
      Image: {
        ...ReactNative.Image,
        // expo-asset installs its transformer through this, as on the real one.
        resolveAssetSource: Object.assign(
          jest.fn((_source) => mockFile),
          { setCustomSourceTransformer: jest.fn() },
        ),
        getSize: jest.fn(
          (
            uri: string,
            success: (width: number, height: number) => void,
            failure?: (_error: any) => void, // eslint-disable-line @typescript-eslint/no-unused-vars
          ) => success(100, 100),
        ),
      },
    },
    ReactNative,
  )
})

// jest-expo stubs the asset registry at the path React Native kept it at
// before 0.88, and 0.88 moved it, so every require of an image or a font, all
// of which are module 1 in a test, went unregistered and an icon threw while
// loading its font. This answers with the same stand-in jest-expo gives.
ReactNative.AssetRegistry.getAssetByID = () => ({
  __packager_asset: true,
  fileSystemLocation: "/full/path/to/directory",
  httpServerLocation: "/assets/full/path/to/directory",
  scales: [1],
  fileHashes: ["md5"],
  name: "name",
  type: "type",
  hash: "md5",
  width: 1,
  height: 1,
})

jest.mock("i18next", () => ({
  currentLocale: "en",
  t: (key: string, params: Record<string, string>) => {
    return `${key} ${JSON.stringify(params)}`
  },
  translate: (key: string, params: Record<string, string>) => {
    return `${key} ${JSON.stringify(params)}`
  },
}))

jest.mock("expo-localization", () => ({
  ...jest.requireActual("expo-localization"),
  getLocales: () => [{ languageTag: "en-US", textDirection: "ltr" }],
}))

jest.mock("../app/i18n/index.ts", () => ({
  ensureI18n: () => undefined,
  i18n: {
    isInitialized: true,
    language: "en",
    t: (key: string, params: Record<string, string>) => {
      return `${key} ${JSON.stringify(params)}`
    },
    numberToCurrency: jest.fn(),
  },
}))

// React Native's own mock leaves currentState a bare jest.fn, which reads as
// "not active" to anything that checks it. An app under test is open unless a
// test says otherwise, and the tracker's background clock arms real timers
// for a phone it believes is away.
;(require("react-native") as { AppState: { currentState: string } }).AppState.currentState =
  "active"

declare const tron // eslint-disable-line @typescript-eslint/no-unused-vars

declare global {
  let __TEST__: boolean
}
