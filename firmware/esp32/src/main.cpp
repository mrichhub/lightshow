#include "ddp.hpp"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ETH.h>
#include <FastLED.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <array>
#include <atomic>
#include <sys/time.h>
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

namespace {
	constexpr size_t MaxPixels = 4096, MaxOutputs = 4, MaxBytes = MaxPixels * 3;

	struct Output {
		uint8_t id = 0, pin = 4;
		uint16_t count = 100;
		char order[4] = "GRB";
	};

	struct Config {
		uint32_t version = 1;
		bool local = false;
		uint16_t port = 4048;
		uint32_t timeout = 5000;
		size_t count = 1, total = 100, sourceCount = 0;
		Output outputs[MaxOutputs];
		uint32_t sources[16]{};
	};

	Config desired;
	portMUX_TYPE frameMux = portMUX_INITIALIZER_UNLOCKED, configMux = portMUX_INITIALIZER_UNLOCKED;
	uint8_t buffers[3][MaxBytes]{};
	uint8_t *writeBuffer = buffers[0];
	uint8_t *pendingBuffer = buffers[1];
	uint8_t *readBuffer = buffers[2];
	bool frameReady = false;
	CRGB leds[MaxPixels];
	CLEDController *controllers[40]{};
	std::atomic<uint32_t> appliedVersion{0}, configEpoch{1}, frameCount{0}, outputCount{0},
		renderUs{0}, lastValid{0}, droppedFrames{0}, incompleteFrames{0};
	std::atomic<bool> networkReady{false}, ddpSeen{false}, refreshConfig{false},
		identityReady{false}, restReady{false};
	std::atomic<int> networkState{0};
	TaskHandle_t networkHandle = nullptr, lightingHandle = nullptr, restHandle = nullptr;
	SemaphoreHandle_t identityMutex;
	String deviceId, deviceToken, mqttHost, mqttPassword;
	uint16_t mqttPort = 8883;
	char lastError[128]{};
	portMUX_TYPE errorMux = portMUX_INITIALIZER_UNLOCKED;
	WiFiUDP udp;
	WiFiClientSecure mqttTLS;
	PubSubClient mqttClient(mqttTLS);

	void error(const char *message) {
		portENTER_CRITICAL(&errorMux);
		strlcpy(lastError, message, sizeof(lastError));
		portEXIT_CRITICAL(&errorMux);
		Serial.println(message);
	}

	bool permittedPin(int pin) {
#if LIGHTSHOW_ETHERNET
		return pin == 4 || pin == 14 || pin == 32 || pin == 33;
#else
		constexpr int pins[] = {4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33};

		for (int p : pins)
			if (p == pin)
				return true;
		return false;
#endif
	}

	template <uint8_t Pin> void registerPin() {
		controllers[Pin] = &FastLED.addLeds<WS2811, Pin, RGB>(leds, 0);
	}

	void registerPins() {
		registerPin<4>();
		registerPin<14>();
		registerPin<32>();
		registerPin<33>();
#if !LIGHTSHOW_ETHERNET
		registerPin<13>();
		registerPin<16>();
		registerPin<17>();
		registerPin<18>();
		registerPin<19>();
		registerPin<21>();
		registerPin<22>();
		registerPin<23>();
		registerPin<25>();
		registerPin<26>();
		registerPin<27>();
#endif
	}

	bool parseConfig(JsonVariantConst root, Config &out) {
		if (!root.is<JsonObjectConst>() || !root["configVersion"].is<uint32_t>())
			return false;
#if LIGHTSHOW_ETHERNET
		if (String(root["hardware"]["board"] | "") != "wt32-eth01" ||
			String(root["hardware"]["networkType"] | "") != "ethernet")
			return false;
#else
		if (String(root["hardware"]["board"] | "") != "esp32dev" ||
			String(root["hardware"]["networkType"] | "") != "wifi")
			return false;
#endif
		const String mode = root["mode"] | "";

		if (mode != "listening" && mode != "local")
			return false;

		Config c;
		c.version = root["configVersion"].as<uint32_t>();
		c.local = mode == "local";
		const int port = root["ddp"]["port"] | 0, timeout = root["ddp"]["timeoutMs"] | 0;

		if (!c.version || port < 1024 || port > 65535 || timeout < 1000 || timeout > 60000)
			return false;

		c.port = port;
		c.timeout = timeout;
		const auto outputs = root["outputs"].as<JsonArrayConst>();

		if (outputs.size() < 1 || outputs.size() > MaxOutputs)
			return false;

		c.count = outputs.size();
		c.total = 0;
		size_t i = 0;
		uint64_t pins = 0;
		uint16_t ids = 0;

		for (JsonObjectConst item : outputs) {
			const int pin = item["gpio"] | -1, count = item["pixelCount"] | 0, id = item["id"] | -1;
			const String order = item["colorOrder"] | "";

			if (!permittedPin(pin) || count < 1 || count > 2048 || id < 0 || id > 7 ||
				pins & (uint64_t(1) << pin) || ids & (1 << id) ||
				String(item["chipset"] | "") != "WS2811")
				return false;

			if (order != "RGB" && order != "RBG" && order != "GRB" && order != "GBR" &&
				order != "BRG" && order != "BGR")
				return false;

			pins |= uint64_t(1) << pin;
			ids |= 1 << id;
			auto &o = c.outputs[i++];
			o.pin = pin;
			o.count = count;
			o.id = id;
			strlcpy(o.order, order.c_str(), 4);
			c.total += count;
		}

		if (c.total > MaxPixels)
			return false;

		const auto sources = root["ddp"]["allowedSources"].as<JsonArrayConst>();

		if (sources.size() > 16)
			return false;

		for (JsonVariantConst item : sources) {
			IPAddress ip;

			if (!ip.fromString(item.as<const char *>()))
				return false;

			for (size_t j = 0; j < c.sourceCount; j++)
				if (c.sources[j] == uint32_t(ip))
					return false;

			c.sources[c.sourceCount++] = uint32_t(ip);
		}

		out = c;
		return true;
	}

	void queueConfig(const Config &config) {
		portENTER_CRITICAL(&configMux);
		desired = config;
		configEpoch.fetch_add(1);
		portEXIT_CRITICAL(&configMux);
	}

	Config configCopy(uint32_t *epoch = nullptr) {
		portENTER_CRITICAL(&configMux);
		Config c = desired;

		if (epoch)
			*epoch = configEpoch.load();
		portEXIT_CRITICAL(&configMux);
		return c;
	}

	uint8_t channel(const uint8_t *p, char c) {
		return p[c == 'R' ? 0 : c == 'G' ? 1 : 2];
	}

	void lightingTask(void *) {
		registerPins();
		uint32_t epoch = 0;
		Config c;
		TickType_t wake = xTaskGetTickCount();

		for (;;) {
			const auto start = micros();

			if (epoch != configEpoch.load()) {
				FastLED.clear(true);
				c = configCopy(&epoch);

				for (auto *controller : controllers)
					if (controller)
						controller->setLeds(leds, 0);
				size_t offset = 0;

				for (size_t i = 0; i < c.count; i++) {
					auto &out = c.outputs[i];
					controllers[out.pin]->setLeds(leds + offset, out.count);
					offset += out.count;
				}

				memset(readBuffer, 0, MaxBytes);
				appliedVersion = c.version;
			}

			portENTER_CRITICAL(&frameMux);

			if (frameReady) {
				std::swap(readBuffer, pendingBuffer);
				frameReady = false;
			}

			portEXIT_CRITICAL(&frameMux);
			const bool timeout = !ddpSeen.load()
									 ? millis() > 5000
									 : uint32_t(millis() - lastValid.load()) >= c.timeout;
			size_t offset = 0;

			for (size_t o = 0; o < c.count; o++) {
				const auto &out = c.outputs[o];

				for (size_t j = 0; j < out.count; j++) {
					const size_t i = offset + j;
					uint8_t rgb[3]{};

					if (c.local) {
						const CRGB color = CHSV((millis() / 20 + i * 3) % 256, 255, 70);
						rgb[0] = color.r;
						rgb[1] = color.g;
						rgb[2] = color.b;
					} else if (!timeout) {
						memcpy(rgb, readBuffer + i * 3, 3);

						if (!ddpSeen.load() && i == 0) {
							if (networkState == 0) {
								rgb[0] = 60;
								rgb[1] = 40;
							} else if (networkState < 0)
								rgb[0] = 70;
							else
								rgb[1] = 50;
						}
					} else if (!networkReady.load() && i == 0) {
						if (networkState < 0)
							rgb[0] = 70;
						else {
							rgb[0] = 60;
							rgb[1] = 40;
						}
					}

					leds[i] = CRGB(channel(rgb, out.order[0]), channel(rgb, out.order[1]),
								   channel(rgb, out.order[2]));
				}

				offset += out.count;
			}

			FastLED.show();
			renderUs = micros() - start;
			outputCount++;
			vTaskDelayUntil(&wake, pdMS_TO_TICKS(25));
		}
	}

	String hardwareId() {
		uint8_t mac[6];
		esp_efuse_mac_get_default(mac);
		char id[32];
		snprintf(id, sizeof(id), "esp32-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3],
				 mac[4], mac[5]);
		return id;
	}

	bool request(const char *path, const String &credential, const String *body,
				 JsonDocument &response) {
		WiFiClientSecure tls;
		tls.setCACert(LIGHTSHOW_CA);
		tls.setTimeout(3000);
		HTTPClient http;
		http.setConnectTimeout(3000);
		http.setTimeout(3000);

		if (!http.begin(tls, String(LIGHTSHOW_API_URL) + path)) {
			error("HTTPS begin failed");
			return false;
		}

		http.addHeader("Authorization", "Bearer " + credential);
		http.addHeader("Content-Type", "application/json");
		const int status = body ? http.POST(*body) : http.GET();

		if (status != 200) {
			char msg[96];
			snprintf(msg, sizeof(msg), "REST %s failed (%d)", path, status);
			error(msg);
			http.end();
			return false;
		}

		const String data = http.getString();
		const auto err = deserializeJson(response, data);
		http.end();

		if (err) {
			error("Invalid REST JSON");
			return false;
		}

		return true;
	}

	bool saveConfig(JsonVariantConst root, Preferences &nvs) {
		Config c;

		if (!parseConfig(root, c)) {
			error("Configuration validation failed");
			return false;
		}

		String encoded;
		serializeJson(root, encoded);

		if (nvs.putString("config", encoded) == 0) {
			error("Configuration cache write failed");
			return false;
		}

		queueConfig(c);
		return true;
	}

	void restTask(void *) {
		Preferences nvs;
		nvs.begin("lightshow", false);
		String saved = nvs.getString("config", "");

		if (saved.length()) {
			JsonDocument json;

			if (!deserializeJson(json, saved)) {
				Config c;

				if (parseConfig(json.as<JsonVariantConst>(), c))
					queueConfig(c);
			}
		}

		deviceId = nvs.getString("deviceId", "");
		deviceToken = nvs.getString("token", "");

		if (LIGHTSHOW_INITIAL_TIME > 0 && time(nullptr) < LIGHTSHOW_INITIAL_TIME) {
			timeval tv{LIGHTSHOW_INITIAL_TIME, 0};
			settimeofday(&tv, nullptr);
		}

		uint32_t lastHeartbeat = 0, lastInit = 0, previousFrames = 0, previousOutputs = 0;

		for (;;) {
			vTaskDelay(pdMS_TO_TICKS(100));

			if (!networkReady)
				continue;

			if (!restReady && uint32_t(millis() - lastInit) > 5000) {
				lastInit = millis();

				if (!strlen(LIGHTSHOW_CA)) {
					error("Install deployment public CA bundle in secrets.h");
					continue;
				}

				JsonDocument body, response;
				body["hardwareId"] = hardwareId();
#if LIGHTSHOW_ETHERNET
				body["board"] = "wt32-eth01";
#else
				body["board"] = "esp32dev";
#endif
				String encoded;
				serializeJson(body, encoded);
				const String credential =
					deviceToken.length() ? deviceToken : String(LIGHTSHOW_PROVISIONING_TOKEN);

				if (credential.isEmpty()) {
					error("Enrollment credential missing");
					continue;
				}

				if (!request("/v1/devices/init", credential, &encoded, response))
					continue;
				const String id = response["deviceId"] | "",
							 fresh = response["token"] | deviceToken;
				const String url = response["mqtt"]["url"] | "",
							 pass = response["mqtt"]["password"] | "";

				if (id.length() != 6 || fresh.length() != 43 || !url.startsWith("mqtts://") ||
					pass.length() != 43) {
					error("Invalid initialization response");
					continue;
				}

				// Save REST identity first: subsequent boots recover an interrupted MQTT
				// provisioning response.
				if (!nvs.putString("deviceId", id) || !nvs.putString("token", fresh)) {
					error("Identity storage failed");
					continue;
				}

				deviceId = id;
				deviceToken = fresh;

				if (!saveConfig(response["config"], nvs))
					continue;
				String host = url.substring(8);
				const int colon = host.indexOf(':');
				uint16_t port = 8883;

				if (colon >= 0) {
					port = host.substring(colon + 1).toInt();
					host = host.substring(0, colon);
				}

				xSemaphoreTake(identityMutex, portMAX_DELAY);
				mqttHost = host;
				mqttPort = port;
				mqttPassword = pass;
				xSemaphoreGive(identityMutex);
				nvs.putBool("provisioned", true);
				identityReady = true;
				restReady = true;
			}

			if (!restReady)
				continue;

			if (refreshConfig.exchange(false)) {
				JsonDocument response;

				if (request("/v1/devices/config", deviceToken, nullptr, response))
					saveConfig(response.as<JsonVariantConst>(), nvs);
			}

			if (uint32_t(millis() - lastHeartbeat) < 5000)
				continue;
			lastHeartbeat = millis();
			const auto c = configCopy();
			JsonDocument body, response;
			body["uptime"] = millis() / 1000.0;
			body["firmwareVersion"] = "0.1.0";
#if LIGHTSHOW_ETHERNET
			body["board"] = "wt32-eth01";
			body["network"]["type"] = "ethernet";
			body["network"]["ip"] = ETH.localIP().toString();
#else
			body["board"] = "esp32dev";
			body["network"]["type"] = "wifi";
			body["network"]["ip"] = WiFi.localIP().toString();
			body["network"]["rssi"] = WiFi.RSSI();
#endif
			body["mode"] = c.local ? "local" : "listening";
			body["network"]["connected"] = networkReady.load();
			body["freeHeap"] = ESP.getFreeHeap();
			body["minHeap"] = ESP.getMinFreeHeap();
			body["networkStack"] = uxTaskGetStackHighWaterMark(networkHandle);
			body["lightingStack"] = uxTaskGetStackHighWaterMark(lightingHandle);
			const uint32_t frames = frameCount.load(), outputs = outputCount.load();
			body["ddpFps"] = (frames - previousFrames) / 5.0;
			body["ledFps"] = (outputs - previousOutputs) / 5.0;
			previousFrames = frames;
			previousOutputs = outputs;
			body["droppedFrames"] = droppedFrames.load();
			body["incompleteFrames"] = incompleteFrames.load();

			if (ddpSeen.load())
				body["lastDdpMs"] = uint32_t(millis() - lastValid.load());
			else
				body["lastDdpMs"] = nullptr;
			body["renderDurationUs"] = renderUs.load();
			body["configVersion"] = appliedVersion.load();
			char err[128];
			portENTER_CRITICAL(&errorMux);
			strlcpy(err, lastError, sizeof(err));
			portEXIT_CRITICAL(&errorMux);

			if (strlen(err))
				body["lastError"] = err;
			String encoded;
			serializeJson(body, encoded);

			if (request("/v1/devices/heartbeat", deviceToken, &encoded, response)) {
				if ((response["configVersion"] | 0) > appliedVersion.load())
					refreshConfig = true;
				portENTER_CRITICAL(&errorMux);
				lastError[0] = 0;
				portEXIT_CRITICAL(&errorMux);
			}
		}
	}

	void networkTask(void *) {
#if LIGHTSHOW_ETHERNET
		ETH.begin(1, 16, 23, 18, ETH_PHY_LAN8720, ETH_CLOCK_GPIO0_IN);
#else
		WiFi.mode(WIFI_STA);
		WiFi.setAutoReconnect(true);
		WiFi.begin(LIGHTSHOW_WIFI_SSID, LIGHTSHOW_WIFI_PASSWORD);
#endif
		configTime(0, 0, LIGHTSHOW_NTP_HOST);
		mqttTLS.setCACert(LIGHTSHOW_CA);
		mqttTLS.setTimeout(2000);
		mqttClient.setSocketTimeout(2);
		mqttClient.setBufferSize(2048);
		mqttClient.setCallback([](char *, uint8_t *payload, unsigned int length) {
			JsonDocument cmd;

			if (deserializeJson(cmd, payload, length))
				return;

			if (String(cmd["type"] | "") == "configUpdated") {
				if ((cmd["force"] | false) || (cmd["configVersion"] | 0) > appliedVersion.load())
					refreshConfig = true;
			}
		});
		Config c;
		uint32_t epoch = 0, lastMqtt = 0, rejected = 0;
		lightshow::DdpAssembler assembler(writeBuffer, 300);
		uint8_t packet[1472];

		for (;;) {
#if LIGHTSHOW_ETHERNET
			const bool online = ETH.linkUp() && uint32_t(ETH.localIP()) != 0;
#else
			const bool online = WiFi.status() == WL_CONNECTED;
#endif
			networkReady = online;
			networkState = online ? 1 : millis() > 15000 ? -1 : 0;

			if (epoch != configEpoch.load()) {
				c = configCopy(&epoch);
				udp.stop();
				udp.begin(c.port);
				assembler.configure(c.total * 3, c.timeout);
				ddpSeen = false;
				portENTER_CRITICAL(&frameMux);
				frameReady = false;
				portEXIT_CRITICAL(&frameMux);
			}

			// A bounded burst prevents UDP traffic from starving MQTT and reconnection
			// work.
			for (int burst = 0; burst < 24; burst++) {
				const int size = udp.parsePacket();

				if (size <= 0)
					break;
				const uint32_t source = uint32_t(udp.remoteIP());
				bool allowed = false;

				for (size_t i = 0; i < c.sourceCount; i++)
					allowed |= c.sources[i] == source;

				if (!allowed || size > int(sizeof(packet)) || c.local ||
					appliedVersion.load() != c.version) {
					udp.flush();
					droppedFrames = assembler.dropped + ++rejected;
					continue;
				}

				const int received = udp.read(packet, sizeof(packet));
				const bool complete = assembler.accept(packet, received, source, true, millis());

				if (assembler.seen()) {
					lastValid = millis() - assembler.age(millis());
					ddpSeen = true;
				}

				droppedFrames = assembler.dropped + rejected;
				incompleteFrames = assembler.incomplete;
				frameCount = assembler.frames;

				if (complete) {
					portENTER_CRITICAL(&frameMux);
					std::swap(writeBuffer, pendingBuffer);
					frameReady = true;
					portEXIT_CRITICAL(&frameMux);
					assembler.buffer(writeBuffer);
				}
			}

			if (online && identityReady) {
				if (!mqttClient.connected() && uint32_t(millis() - lastMqtt) > 5000) {
					lastMqtt = millis();
					xSemaphoreTake(identityMutex, portMAX_DELAY);
					const String pass = mqttPassword, id = deviceId;
					const auto port = mqttPort;
					xSemaphoreGive(identityMutex);
					mqttClient.setServer(mqttHost.c_str(), port);
					const String availability = "lightshow/devices/" + id + "/availability";

					if (mqttClient.connect(("device-" + id).c_str(), id.c_str(), pass.c_str(),
										   availability.c_str(), 1, true, "offline")) {
						mqttClient.subscribe(("lightshow/devices/" + id + "/command").c_str(), 1);
						mqttClient.publish(availability.c_str(), "online", true);
						refreshConfig = true;
					}
				}

				mqttClient.loop();
				static uint32_t stateAt = 0;

				if (mqttClient.connected() && millis() - stateAt > 5000) {
					stateAt = millis();
					char state[100];
					snprintf(state, sizeof(state), "{\"configVersion\":%u,\"mode\":\"%s\"}",
							 appliedVersion.load(), c.local ? "local" : "listening");
					mqttClient.publish(("lightshow/devices/" + deviceId + "/state").c_str(), state,
									   true);
				}
			}

			vTaskDelay(pdMS_TO_TICKS(1));
		}
	}
} // namespace

void setup() {
	Serial.begin(115200);
	identityMutex = xSemaphoreCreateMutex();
	xTaskCreatePinnedToCore(lightingTask, "lighting", 6144, nullptr, 3, &lightingHandle, 1);
	xTaskCreatePinnedToCore(networkTask, "network", 8192, nullptr, 2, &networkHandle, 0);
	// Blocking HTTPS runs in a separate worker on core 0 so UDP remains
	// responsive. TLS processing can be CPU-bound, so share the idle priority
	// to let IDLE0 service its watchdog during consecutive TLS handshakes.
	xTaskCreatePinnedToCore(restTask, "rest", 16384, nullptr, tskIDLE_PRIORITY, &restHandle, 0);
}

void loop() {
	vTaskDelay(pdMS_TO_TICKS(1000));
}
