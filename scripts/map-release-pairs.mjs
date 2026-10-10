// Keep registry verification bounded without enlarging the 90-minute release ceiling.
export async function mapReleasePairs(values, operation) {
  const output = [];
  for (let offset = 0; offset < values.length; offset += 2) {
    const results = await Promise.allSettled(values.slice(offset, offset + 2).map(operation));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      output.push(result.value);
    }
  }
  return output;
}
