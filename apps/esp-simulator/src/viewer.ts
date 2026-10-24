export const viewerHtml = /* HTML */ `
	<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Lightshow simulated pixels</title>

			<style>
				body {
					background: #10151e;
					color: #edf1f5;
					font: 16px system-ui;
					padding: 30px;
				}

				canvas {
					width: 100%;
					image-rendering: pixelated;
				}

				pre {
					color: #9aa8b6;
				}
			</style>
		</head>

		<body>
			<h1>Simulated ESP</h1>
			<pre id="info"></pre>
			<canvas width="1000" height="200"></canvas>

			<script>
				const canvas = document.querySelector("canvas")

				const ctx = canvas.getContext("2d")

				setInterval(async () => {
					const d = await (await fetch("/pixels")).json()

					document.querySelector("#info").textContent = JSON.stringify(
						{ ...d, pixels: undefined },
						null,
						2,
					)

					ctx.clearRect(0, 0, 1000, 200)

					d.pixels.forEach((v, i) => {
						if (i % 3) return

						const p = i / 3

						ctx.fillStyle = "rgb(" + d.pixels.slice(i, i + 3).join(",") + ")"
						ctx.fillRect((p % 50) * 20, Math.floor(p / 50) * 20, 17, 17)
					})
				}, 100)
			</script>
		</body>
	</html>
`
