import { View } from "react-native"
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs"
import { NavigationContainer } from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"
import { render } from "@testing-library/react-native"

// The navigation packages are released as a set. Dependabot once moved
// native-stack on its own to a release that wants a newer
// @react-navigation/native, the types still agreed, and every build died on
// its first screen with "undefined is not a function". Rendering the two
// navigators the app is built from catches a set that does not belong
// together before a phone does.
const FirstScreen = () => <View testID="first screen" />

describe("the navigation packages", () => {
  it("render a native stack", () => {
    const Stack = createNativeStackNavigator()
    const { getByTestId } = render(
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="First" component={FirstScreen} />
        </Stack.Navigator>
      </NavigationContainer>,
    )
    expect(getByTestId("first screen")).toBeDefined()
  })

  it("render bottom tabs", () => {
    const Tabs = createBottomTabNavigator()
    const { getByTestId } = render(
      <NavigationContainer>
        <Tabs.Navigator>
          <Tabs.Screen name="First" component={FirstScreen} />
        </Tabs.Navigator>
      </NavigationContainer>,
    )
    expect(getByTestId("first screen")).toBeDefined()
  })
})
