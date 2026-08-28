import { bestLabel, labelFor } from "./geocode"

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

  // Android's geocoder answers with an Open Location Code where it has no
  // street: "8H+2W", "7JVW4XPP+2H". They are coordinates spelled differently
  // and mean nothing to a family reading "near 8H+2W".
  it("never reads back a plus code", () => {
    expect(labelFor(address({ name: "8H+2W", city: "Islamabad" }))).toBe("Islamabad")
    expect(labelFor(address({ street: "7JVW4XPP+2H", district: "G-8" }))).toBe("G-8")
    expect(labelFor(address({ name: "4XPP+2H Islamabad, Pakistan", city: "Islamabad" }))).toBe(
      "Islamabad",
    )
    expect(labelFor(address({ name: "8H+2W" }))).toBeNull()
  })

  it("never reads back a bare house number or a postcode", () => {
    expect(labelFor(address({ name: "42", city: "Bristol" }))).toBe("Bristol")
    expect(labelFor(address({ street: "BS1 6QA", city: "Bristol" }))).toBe("Bristol")
  })

  it("takes the town when a street is all it would otherwise have", () => {
    expect(labelFor(address({ subregion: "Islamabad Capital Territory" }))).toBe(
      "Islamabad Capital Territory",
    )
    expect(labelFor(address({ region: "Punjab" }))).toBe("Punjab")
  })

  it("falls back to the district, and to nothing at sea", () => {
    expect(labelFor(address({ district: "Redcliffe" }))).toBe("Redcliffe")
    expect(labelFor(address({}))).toBeNull()
    expect(labelFor(undefined)).toBeNull()
  })
})

describe("bestLabel", () => {
  // Android returns several addresses for a spot, and the first is often
  // the plus code while the second is the street.
  it("takes the first answer that says something", () => {
    expect(
      bestLabel([address({ name: "8H+2W" }), address({ street: "Ibn-e-Sina Road", city: "G-8" })]),
    ).toBe("Ibn-e-Sina Road, G-8")
  })

  it("is null when every answer is a plus code or empty", () => {
    expect(bestLabel([address({ name: "8H+2W" }), address({})])).toBeNull()
    expect(bestLabel([])).toBeNull()
    expect(bestLabel(undefined)).toBeNull()
  })
})
