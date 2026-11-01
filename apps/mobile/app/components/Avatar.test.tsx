import { render } from "@testing-library/react-native"
import { Image } from "expo-image"

import { Avatar } from "./Avatar"
import { ThemeProvider } from "../theme/context"

const person = (name: string) => ({
  displayName: name,
  avatarColor: "#7A5C3E",
  avatarUrl: `https://media.example/${name}.jpg`,
})

describe("Avatar", () => {
  // The selected member's card keeps one Avatar and swaps the person in it.
  // Without a key per photo the image view held the last person's picture
  // while the next one loaded, so a card showed one name with another face.
  it("keys the image to the photo, so a reused view lets the old one go", () => {
    const { UNSAFE_getByType, rerender } = render(
      <ThemeProvider>
        <Avatar user={person("ana")} />
      </ThemeProvider>,
    )
    expect(UNSAFE_getByType(Image).props.recyclingKey).toBe("https://media.example/ana.jpg")

    rerender(
      <ThemeProvider>
        <Avatar user={person("ben")} />
      </ThemeProvider>,
    )
    expect(UNSAFE_getByType(Image).props.recyclingKey).toBe("https://media.example/ben.jpg")
  })
})
