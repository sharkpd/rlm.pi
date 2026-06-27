let failures = 0;

export function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

export function fail(): void {
  failures++;
}

export function failureCount(): number {
  return failures;
}
