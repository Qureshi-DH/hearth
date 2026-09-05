// Day grouping and clock formatting depend on the local zone, so the suite
// runs in one, whatever the machine or CI runner is set to. Workers inherit it.
module.exports = () => {
  process.env.TZ = "America/Los_Angeles"
}
