import {
	compileMappings,
	type DeviceConfig,
	type Element,
	type Scene,
	type Override,
} from "@lightshow/models"
import { compileEffect, colorRGB, type RenderEffect } from "@lightshow/effects"

export class Renderer {
	readonly physical = new Map<string, Buffer>()
	readonly logical = new Map<string, Buffer>()
	private compiled: ReturnType<typeof compileMappings>
	private effects: { render: RenderEffect; targets: Buffer[] }[] = []
	private overrides: {
		buffer: Buffer
		rgb: [number, number, number]
		pixel?: number
		base: number
		length: number
		physical: boolean
	}[] = []

	constructor(
		readonly devices: DeviceConfig[],
		readonly elements: Element[],
		scene: Scene | null,
		overrides: Override[] = [],
	) {
		this.compiled = compileMappings(devices, elements)

		for (const d of devices)
			this.physical.set(
				d.deviceId,
				Buffer.alloc(d.outputs.reduce((n, o) => n + o.pixelCount * 3, 0)),
			)

		for (const e of elements) this.logical.set(e.id, Buffer.alloc(e.pixelCount * 3))

		for (const effect of scene?.effects ?? [])
			this.effects.push({
				render: compileEffect(effect),
				targets: effect.targets.map((id) => {
					const b = this.logical.get(id)

					if (!b) throw new Error("Unknown effect target")

					return b
				}),
			})

		for (const o of overrides) {
			const rgb = colorRGB(o.color).map((n) => Math.round(n * o.brightness)) as [
				number,
				number,
				number,
			]

			if (o.elementId) {
				const b = this.logical.get(o.elementId)

				if (b)
					this.overrides.push({
						buffer: b,
						rgb,
						pixel: o.pixel,
						base: 0,
						length: b.length / 3,
						physical: false,
					})
			} else {
				const device = devices.find((d) => d.deviceId === o.deviceId)
				const out = device?.outputs[o.outputIndex ?? -1]
				const b = this.physical.get(o.deviceId!)

				if (device && out && b)
					this.overrides.push({
						buffer: b,
						rgb,
						pixel: o.pixel,
						base: device.outputs
							.slice(0, o.outputIndex)
							.reduce((n, p) => n + p.pixelCount, 0),
						length: out.pixelCount,
						physical: true,
					})
			}
		}
	}

	private apply(o: (typeof this.overrides)[number]) {
		for (let i = o.pixel ?? 0; i < (o.pixel === undefined ? o.length : o.pixel + 1); i++) {
			const p = (o.base + i) * 3

			o.buffer[p] = o.rgb[0]
			o.buffer[p + 1] = o.rgb[1]
			o.buffer[p + 2] = o.rgb[2]
		}
	}

	frame(timeMs: number): Map<string, Buffer> {
		for (const b of this.physical.values()) b.fill(0)

		for (const b of this.logical.values()) b.fill(0)

		for (const effect of this.effects) for (const b of effect.targets) effect.render(b, timeMs)

		for (const o of this.overrides) if (!o.physical) this.apply(o)

		for (const m of this.compiled.mappings) {
			const logical = this.logical.get(m.elementId)!
			const physical = this.physical.get(m.deviceId)!

			for (const link of m.links) {
				const a = link.logical * 3
				const b = link.physical * 3

				physical[b] = logical[a]!
				physical[b + 1] = logical[a + 1]!
				physical[b + 2] = logical[a + 2]!
			}
		}

		for (const o of this.overrides) if (o.physical) this.apply(o)

		for (const [id, skips] of this.compiled.skipped) {
			const b = this.physical.get(id)!

			for (const p of skips) {
				b[p * 3] = 0
				b[p * 3 + 1] = 0
				b[p * 3 + 2] = 0
			}
		}

		return this.physical
	}
}
