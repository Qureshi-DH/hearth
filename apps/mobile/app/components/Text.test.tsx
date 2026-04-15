import { NavigationContainer } from "@react-navigation/native"
import { render } from "@testing-library/react-native"

import { Text } from "./Text"
import { ThemeProvider } from "../theme/context"

const testText = "Test string"

describe("Text", () => {
  it("should render the component", () => {
    const { getByText } = render(
      <ThemeProvider>
        <NavigationContainer>
          <Text text={testText} />
        </NavigationContainer>
      </ThemeProvider>,
    )
    expect(getByText(testText)).toBeDefined()
  })
})
