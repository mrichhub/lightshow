import { test } from "node:test"
import assert from "node:assert/strict"
import { Renderer } from "../apps/show-engine/src/renderer.js"
import { defaultConfig, type Element, type Scene } from "../packages/models/src/index.js"
import { compileEffect } from "../packages/effects/src/index.js"

test("one composition maps cross-device effects, overrides and black skips", () => {
	const a = defaultConfig("ABC123", "esp32dev")
	const b = defaultConfig("DEF456", "esp32dev")
	const element: Element = {
		id: "ghost",
		name: "Ghost",
		pixelCount: 4,
		segments: [
			{
				deviceId: a.deviceId,
				outputIndex: 0,
				startPixel: 0,
				physicalPixelCount: 3,
				elementStartPixel: 0,
				skippedPixels: [1],
			},
			{
				deviceId: b.deviceId,
				outputIndex: 0,
				startPixel: 0,
				physicalPixelCount: 2,
				elementStartPixel: 2,
				skippedPixels: [],
			},
		],
	}
	const scene: Scene = {
		id: "scene",
		name: "Scene",
		effects: [{ type: "solid", targets: ["ghost"], params: { color: "#ff0000" } }],
	}
	const renderer = new Renderer([a, b], [element], scene, [
		{ elementId: "ghost", pixel: 2, color: "#00ff00", brightness: 1 },
		{ deviceId: a.deviceId, outputIndex: 0, color: "#0000ff", brightness: 1 },
	])
	const result = renderer.frame(0)

	assert.deepEqual([...result.get(a.deviceId)!.subarray(0, 9)], [0, 0, 255, 0, 0, 0, 0, 0, 255])
	assert.deepEqual([...result.get(b.deviceId)!.subarray(0, 6)], [0, 255, 0, 255, 0, 0])
	assert.equal(renderer.frame(25), result)
})

test("all six effects produce bounded RGB pixels and deterministic flicker", () => {
	for (const type of ["solid", "pulse", "fade", "chase", "rainbow", "flicker"] as const) {
		const render = compileEffect({
			type,
			targets: ["ghost"],
			params: { color: "#ff6600", color2: "#0000ff", seed: 12 },
		})
		const a = new Uint8Array(120)
		const b = new Uint8Array(120)

		render(a, 1000)
		render(b, 1000)
		assert.deepEqual(a, b)
		assert.ok(a.some((v) => v > 0))
	}

	const pulse = compileEffect({
		type: "pulse",
		targets: ["x"],
		params: { color: "#ffffff", minBrightness: 0, maxBrightness: 1, durationMs: 1000 },
	})
	const a = new Uint8Array(3)

	pulse(a, 0)
	assert.deepEqual([...a], [0, 0, 0])
	pulse(a, 500)
	assert.deepEqual([...a], [255, 255, 255])
})
