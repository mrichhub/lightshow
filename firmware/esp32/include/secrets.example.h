#pragma once
// Copy to secrets.h or generate with scripts/firmware-secrets.mjs. Never commit secrets.h.
#define LIGHTSHOW_API_URL "https://lightshow.home.arpa"
#define LIGHTSHOW_PROVISIONING_TOKEN ""
#define LIGHTSHOW_WIFI_SSID ""
#define LIGHTSHOW_WIFI_PASSWORD ""
#define LIGHTSHOW_NTP_HOST "lightshow.home.arpa"
#define LIGHTSHOW_INITIAL_TIME 0
static const char LIGHTSHOW_CA[] = ""; // PEM bundle with HTTPS + MQTT public roots.
