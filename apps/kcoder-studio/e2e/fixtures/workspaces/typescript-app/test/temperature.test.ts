import { celsiusToFahrenheit, fahrenheitToCelsius } from "../src/temperature.js";

function assertEqual(actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

assertEqual(celsiusToFahrenheit(0), 32);
assertEqual(fahrenheitToCelsius(32), 0);
