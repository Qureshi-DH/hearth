import { labelFor } from "./geocode"

const address = (fields: Record<string, string | null>) =>
  ({
    city: null,
    district: null,
    streetNumber: null,
    street: null,
    region: null,
    subregion: null,
    country: null,
    postalCode: null,
    name: null,
    isoCountryCode: null,
    timezone: null,
    formattedAddress: null,
    ...fields,
  }) as never

describe("labelFor", () => {
  it("names the street and the town", () => {
    expect(labelFor(address({ street: "Queen Street", city: "Bristol" }))).toBe(
      "Queen Street, Bristol",
    )
  })

  it("prefers a landmark to its street, but not a house number", () => {
    expect(
      labelFor(address({ name: "Castle Park", street: "Castle Street", city: "Bristol" })),
    ).toBe("Castle Park, Bristol")
    expect(
      labelFor(address({ name: "12 Queen Street", street: "Queen Street", city: "Bristol" })),
    ).toBe("Queen Street, Bristol")
  })

  it("falls back to the district, and to nothing at sea", () => {
    expect(labelFor(address({ district: "Redcliffe" }))).toBe("Redcliffe")
    expect(labelFor(address({}))).toBeNull()
    expect(labelFor(undefined)).toBeNull()
  })
})
