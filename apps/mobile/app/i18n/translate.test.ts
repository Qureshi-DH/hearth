jest.unmock("i18next")
jest.unmock("./index")

/**
 * Android starts Hearth with no screen to run the tracker, and the app's root
 * component, which used to be the only thing that started i18n, never mounts.
 * Whatever that process says, a "signed out" notification most of all, has to
 * come out in words and not as its keys.
 */
describe("translate before anything has started i18n", () => {
  it("still finds the words", () => {
    jest.isolateModules(() => {
      const { translate } = require("./translate") as typeof import("./translate")
      const title = translate("session:signedOutTitle")
      expect(title).toBe("Signed out of Hearth")
    })
  })
})
