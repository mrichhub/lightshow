export const DDP_PORT = 4048

export const HEADER_SIZE = 10

export const RGB24 = 0x0b

export interface Packet {
	offset: number
	sequence: number
	push: boolean
	data: Buffer
}

export function decodePacket(packet: Buffer): Packet {
	if (
		packet.length < HEADER_SIZE ||
		(packet[0] !== 0x40 && packet[0] !== 0x41) ||
		packet[1]! > 15 ||
		packet[2] !== RGB24 ||
		packet[3] !== 1
	)
		throw new Error("Unsupported DDP header")

	const length = packet.readUInt16BE(8)
	const offset = packet.readUInt32BE(4)

	if (length !== packet.length - 10 || length % 3 !== 0 || offset % 3 !== 0)
		throw new Error("Invalid RGB packet length/offset")

	return { offset, sequence: packet[1]!, push: !!(packet[0]! & 1), data: packet.subarray(10) }
}

export class DdpEncoder {
	readonly packets: Buffer[] = []
	private sequence = 0

	constructor(
		readonly frameBytes: number,
		maxPayload = 1440,
	) {
		if (frameBytes <= 0 || frameBytes % 3 || maxPayload < 3 || maxPayload > 65535)
			throw new Error("Invalid frame size")

		maxPayload -= maxPayload % 3

		for (let offset = 0; offset < frameBytes; offset += maxPayload) {
			const length = Math.min(frameBytes - offset, maxPayload)
			const p = Buffer.alloc(10 + length)

			p[0] = offset + length === frameBytes ? 0x41 : 0x40
			p[2] = RGB24
			p[3] = 1
			p.writeUInt32BE(offset, 4)
			p.writeUInt16BE(length, 8)
			this.packets.push(p)
		}
	}

	encode(frame: Uint8Array): readonly Buffer[] {
		if (frame.length !== this.frameBytes) throw new Error("Frame length changed")

		for (const p of this.packets) {
			this.sequence = (this.sequence % 15) + 1
			p[1] = this.sequence

			const offset = p.readUInt32BE(4)

			p.set(frame.subarray(offset, offset + p.length - 10), 10)
		}

		return this.packets
	}
}

export function encodeFrame(frame: Uint8Array, maxPayload = 1440): Buffer[] {
	return [...new DdpEncoder(frame.length, maxPayload).encode(frame)]
}

/** Strict contiguous assembly: incomplete/reordered frames are dropped; next offset zero recovers.
 * Standard DDP has no frame identifier, so offsets and per-packet sequence continuity establish completeness. */
export class DdpReceiver {
	readonly pixels: Buffer
	private staging: Buffer
	private expected = 0
	private previousSequence = 0
	private source?: string
	lastValidAt: number | null = null
	frames = 0
	dropped = 0
	incomplete = 0
	private assembling = false

	constructor(
		readonly frameBytes: number,
		public allowedSources: readonly string[],
		public timeoutMs = 5000,
	) {
		if (frameBytes < 3 || frameBytes % 3) throw new Error("Invalid RGB frame length")

		this.pixels = Buffer.alloc(frameBytes)
		this.staging = Buffer.alloc(frameBytes)
	}

	accept(packet: Buffer, source: string, now = performance.now()): boolean {
		if (!this.allowedSources.includes(source)) {
			this.dropped++

			return false
		}

		let p: Packet

		try {
			p = decodePacket(packet)
		} catch {
			this.dropped++

			return false
		}

		if (p.offset + p.data.length > this.frameBytes) {
			this.dropped++

			return false
		}

		if (this.lastValidAt !== null && now - this.lastValidAt >= this.timeoutMs) {
			if (this.assembling) this.incomplete++

			this.reset()
			this.source = undefined
		}

		if (
			this.source &&
			source !== this.source &&
			this.lastValidAt !== null &&
			now - this.lastValidAt < this.timeoutMs
		) {
			this.dropped++

			return false
		}

		if (this.source !== source) {
			this.reset()
			this.source = source
		}

		this.lastValidAt = now

		if (p.offset === 0 && p.data.length) {
			if (this.assembling) this.incomplete++

			this.expected = 0
			this.assembling = true
			this.previousSequence = 0
		}

		if (
			!this.assembling ||
			p.offset !== this.expected ||
			(this.previousSequence && p.sequence && p.sequence !== (this.previousSequence % 15) + 1)
		) {
			this.dropped++

			if (this.assembling) this.incomplete++

			this.reset()

			return false
		}

		p.data.copy(this.staging, p.offset)
		this.expected += p.data.length
		this.previousSequence = p.sequence

		if (p.push) {
			if (this.expected === this.frameBytes) {
				this.staging.copy(this.pixels)
				this.frames++
				this.reset()

				return true
			}

			this.incomplete++
			this.reset()
		}

		return false
	}

	private reset() {
		this.expected = 0
		this.assembling = false
		this.previousSequence = 0
	}

	tick(now = performance.now(), mode: "listening" | "local" = "listening"): boolean {
		if (mode === "local") return false

		if (this.lastValidAt === null || now - this.lastValidAt >= this.timeoutMs) {
			this.pixels.fill(0)

			if (this.assembling) this.incomplete++

			this.reset()
			this.source = undefined

			return true
		}

		return false
	}
}
