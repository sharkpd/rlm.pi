import type { Component } from "@gsd/pi-tui";

export class DynamicBorder implements Component {
  private color: (str: string) => string;
  constructor(color: (str: string) => string = (str) => str) {
    this.color = color;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}
