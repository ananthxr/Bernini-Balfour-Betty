/*
 * Container Tracker - Smart Logging Edition
 * NodeMCU (ESP8266) + MPU6050/6500/9250 + NEO-6M GPS -> Supabase
 *
 * Key ideas:
 *   1. The ACCELEROMETER decides whether we are moving, not the GPS.
 *      A stationary container has near-zero accel variance; a moving
 *      vehicle vibrates constantly. This is far more reliable than
 *      differencing two noisy GPS fixes.
 *   2. GPS fixes are QUALITY GATED (HDOP + satellite count) before use.
 *   3. While MOVING  -> log on distance/heading change, every ~5 s.
 *      While PARKED   -> log one averaged heartbeat every 5 minutes.
 *   4. Readings are BUFFERED and uploaded as a JSON array, so six
 *      uploads become one TLS handshake.
 *
 * ---------------- WIRING (unchanged) ----------------
 *  IMU     VCC->3V3  GND->GND  SCL->D1  SDA->D2
 *  NEO-6M  VCC->3V3  GND->GND  TX ->D5  RX ->D6
 *
 * ---------------- LIBRARIES ----------------
 *   "TinyGPSPlus"       by Mikal Hart
 *   "EspSoftwareSerial" by Dirk Kaar
 *
 * Board: "NodeMCU 0.9 (ESP-12 Module)"
 */

#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ESP8266HTTPClient.h>
#include <Wire.h>
#include <TinyGPSPlus.h>
#include <SoftwareSerial.h>
#include <time.h>

// ============================================================
//  Credentials live in secrets.h, which is NOT committed to git.
//  On a fresh checkout: copy secrets.example.h -> secrets.h and fill it in.
// ============================================================
#include "secrets.h"
const char* WIFI_SSID     = SECRET_WIFI_SSID;
const char* WIFI_PASSWORD = SECRET_WIFI_PASSWORD;
const char* SUPABASE_URL  = SECRET_SUPABASE_URL;
const char* SUPABASE_KEY  = SECRET_SUPABASE_KEY;
const char* DEVICE_ID     = "tracker-01";
// ============================================================

// ---------- Motion detection tuning ----------
// Measured on this build: resting ~0.0015, in motion ~0.04.
// Two levels, not one. A single threshold makes the state flap when the
// variance sits near it (as seen at 0.00479 vs 0.0050). Going MOVING needs
// a clearly higher value than staying MOVING does - classic Schmitt trigger.
#define MOTION_ENTER       0.0120f   // g^2 - must exceed this to start MOVING
#define MOTION_EXIT        0.0040f   // g^2 - must drop below this to go PARKED
#define MOTION_SAMPLES     40        // 40 x 50 ms = 2 s window
#define MOTION_SAMPLE_MS   50
#define MOVE_CONFIRM_MS    3000      // must exceed threshold this long to go MOVING
#define PARK_CONFIRM_MS    30000     // must stay quiet this long to go PARKED

// ---------- GPS quality gate ----------
#define MIN_SATS           5
#define MAX_HDOP           2.5f
#define STATIONARY_KMPH    3.0f      // Doppler speed below this = not moving
#define FIX_MAX_AGE        3000      // ms

// ---------- Logging rules ----------
#define MOVING_SAMPLE_MS   5000      // check for a new point this often
#define MIN_DISTANCE_M     25.0f     // log if we moved at least this far
#define MIN_HEADING_DEG    20.0f     // ...or turned at least this much
#define MOVING_MAX_GAP_MS  60000     // ...or this long has passed anyway
#define PARKED_HEARTBEAT   300000    // 5 min heartbeat while parked

// ---------- Tilt change ----------
// A container being rotated or tipped while stationary is the event that
// matters most, and slow rotation produces almost no accel variance - so
// motion detection alone will never catch it. Orientation is watched
// independently of movement, in BOTH states.
#define TILT_CHANGE_DEG    8.0f      // log if roll or pitch moves this much
#define TILT_MIN_GAP_MS    4000      // but no more often than this
#define TILT_ALERT_DEG     20.0f     // beyond this is a handling alert

// ---------- Upload ----------
#define BUFFER_SIZE        12
#define UPLOAD_INTERVAL    30000     // flush at least this often
#define PRINT_INTERVAL     2000

// ---------- Pins ----------
#define I2C_SDA   D2
#define I2C_SCL   D1
#define GPS_RX    D5
#define GPS_TX    D6
#define GPS_BAUD  9600
#define LED_PIN   D4
#define LED_ON    LOW
#define LED_OFF   HIGH
#define BLINK_MS  500

// ---------- IMU registers ----------
#define REG_SMPLRT_DIV    0x19
#define REG_CONFIG        0x1A
#define REG_GYRO_CONFIG   0x1B
#define REG_ACCEL_CONFIG  0x1C
#define REG_ACCEL_XOUT_H  0x3B
#define REG_PWR_MGMT_1    0x6B
#define REG_WHO_AM_I      0x75

// ---------- Objects ----------
TinyGPSPlus      gps;
SoftwareSerial   gpsSerial(GPS_RX, GPS_TX);
WiFiClientSecure secureClient;

// ---------- IMU ----------
uint8_t imuAddr = 0, imuWho = 0;
bool    isMPU6050 = false;
const float ACCEL_LSB = 8192.0f;   // +/- 4 g
const float GYRO_LSB  = 131.0f;

// ---------- Motion state ----------
enum MotionState { PARKED, MOVING };
MotionState motionState = PARKED;

float  accelWindow[MOTION_SAMPLES];
uint8_t accelIdx = 0;
bool   windowFilled = false;
float  currentVariance = 0;
float  currentRoll = 0, currentPitch = 0;   // live orientation, updated at 20 Hz
unsigned long lastAccelSample = 0;
unsigned long motionAboveSince = 0;   // 0 = not currently above threshold
unsigned long motionBelowSince = 0;

// ---------- Logging state ----------
struct Reading {
  uint32_t epoch;        // 0 = unknown, server will use now()
  double   lat, lng;
  float    roll, pitch, tempC, speed, hdop, heading;
  uint8_t  sats;
  bool     gpsValid;
  bool     moving;
  int16_t  rssi;
};

Reading buffer[BUFFER_SIZE];
uint8_t bufCount = 0;

double   lastLoggedLat = 0, lastLoggedLng = 0;
float    lastLoggedHeading = -1;
float    lastLoggedRoll = 0, lastLoggedPitch = 0;
bool     haveTiltRef = false;
unsigned long lastTiltLog = 0;
bool     haveLastLogged = false;
unsigned long lastLogTime = 0;
unsigned long lastMovingCheck = 0;
unsigned long lastUpload = 0;
unsigned long lastPrint = 0;
unsigned long lastBlink = 0;
bool ledLit = false;

// ---------- Parked position averaging ----------
// Moving average of the parked position, updated once per NEW GPS fix.
//   - First PARK_AVG_WARMUP fixes: an exact average (weight 1/n).
//   - After that: each new fix pulls the average 1/PARK_AVG_WARMUP of the
//     way toward itself, and older fixes slowly fade out.
// There is no growing sum, so nothing can overflow. And because it never
// freezes, a container shifted gently (e.g. by crane) without tripping
// MOVING still shows up at its new spot within a few minutes.
#define PARK_AVG_WARMUP  100        // fixes (~100 s at 1 Hz)
double  parkLat = 0, parkLng = 0;
uint8_t parkSamples = 0;            // counts up to PARK_AVG_WARMUP, then stays

uint32_t uploadOK = 0, uploadFail = 0, droppedRows = 0;

// =====================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println(F("=========================================="));
  Serial.println(F(" Container Tracker - Smart Logging        "));
  Serial.println(F("=========================================="));

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_OFF);

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);
  i2cScan();
  imuInit();

  gpsSerial.begin(GPS_BAUD);
  Serial.println(F("[..]   GPS serial started @ 9600"));

  wifiConnect();
  secureClient.setInsecure();          // prototype only - see note in README
  secureClient.setBufferSizes(1024, 1024);

  // Log the first row ~20 s after boot rather than waiting a full heartbeat.
  // Gives the GPS a moment to find satellites, but still confirms the whole
  // pipeline works without a five-minute wait.
  lastLogTime = millis() - PARKED_HEARTBEAT + 20000;

  Serial.println(F("[..]   Starting in PARKED state"));
  Serial.println(F("       First row in ~20 s, then every 5 min while parked"));
  Serial.println();
}

// =====================================================
void loop() {
  // GPS must be fed constantly
  while (gpsSerial.available() > 0) gps.encode(gpsSerial.read());

  sampleMotion();      // every 50 ms
  updateMotionState(); // hysteresis
  updateLed();

  // --- Two independent triggers ---
  // IMU: orientation change, always armed, regardless of state or GPS
  checkTiltChange();

  // GPS: position logging, gated on actually travelling
  if (motionState == MOVING) handleMoving();
  else                       handleParked();

  if (bufCount >= BUFFER_SIZE ||
      (bufCount > 0 && millis() - lastUpload >= UPLOAD_INTERVAL)) {
    flushBuffer();
  }

  if (millis() - lastPrint >= PRINT_INTERVAL) {
    lastPrint = millis();
    printStatus();
  }
}

// =====================================================
//  MOTION DETECTION - the heart of this sketch
// =====================================================
void sampleMotion() {
  if (millis() - lastAccelSample < MOTION_SAMPLE_MS) return;
  lastAccelSample = millis();
  if (imuAddr == 0) return;

  float ax, ay, az, gx, gy, gz, t;
  imuRead(ax, ay, az, gx, gy, gz, t);

  // Orientation, updated every sample. This is INDEPENDENT of the motion
  // state and of the GPS - a container can be rotated while standing still
  // at one coordinate, and that must be caught.
  currentRoll  = atan2(ay, az) * 180.0 / PI;
  currentPitch = atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;

  // Magnitude of the acceleration vector. Stationary ~1.0 g regardless of
  // how the unit is oriented, which is why we use magnitude not raw axes.
  float mag = sqrt(ax * ax + ay * ay + az * az);

  accelWindow[accelIdx] = mag;
  accelIdx = (accelIdx + 1) % MOTION_SAMPLES;
  if (accelIdx == 0) windowFilled = true;

  if (!windowFilled) return;

  // Variance over the window
  float mean = 0;
  for (uint8_t i = 0; i < MOTION_SAMPLES; i++) mean += accelWindow[i];
  mean /= MOTION_SAMPLES;

  float var = 0;
  for (uint8_t i = 0; i < MOTION_SAMPLES; i++) {
    float d = accelWindow[i] - mean;
    var += d * d;
  }
  currentVariance = var / MOTION_SAMPLES;
}

void updateMotionState() {
  if (!windowFilled) return;

  // Schmitt trigger: which level applies depends on the state we are in
  bool above = (motionState == PARKED)
               ? (currentVariance > MOTION_ENTER)
               : (currentVariance > MOTION_EXIT);
  unsigned long now = millis();

  if (above) {
    motionBelowSince = 0;
    if (motionAboveSince == 0) motionAboveSince = now;

    if (motionState == PARKED && now - motionAboveSince >= MOVE_CONFIRM_MS) {
      motionState = MOVING;
      Serial.println(F(">>> STATE: PARKED -> MOVING"));
      // Force a point immediately so the route starts at the departure spot
      haveLastLogged = false;
      lastMovingCheck = 0;
      parkSamples = 0;                  // next park starts a fresh average
    }
  } else {
    motionAboveSince = 0;
    if (motionBelowSince == 0) motionBelowSince = now;

    if (motionState == MOVING && now - motionBelowSince >= PARK_CONFIRM_MS) {
      motionState = PARKED;
      Serial.println(F(">>> STATE: MOVING -> PARKED"));
      // Log the arrival point straight away
      captureReading(true);
      lastLogTime = now;
    }
  }
}

// =====================================================
//  TILT TRIGGER - runs in BOTH states, independent of GPS
//
//  The IMU and the GPS are two separate sensors answering two separate
//  questions. The GPS answers "where is it?" and only earns an upload
//  while the unit is actually travelling. The IMU answers "which way up
//  is it?" and earns an upload whenever that changes - parked or moving,
//  fix or no fix. A container rotated in a yard never changes coordinate,
//  and slow rotation barely registers as acceleration, so neither the
//  motion detector nor the GPS will ever catch it. This will.
// =====================================================
void checkTiltChange() {
  if (imuAddr == 0 || !windowFilled) return;

  // First run: take a reference and log it so the dashboard has a baseline
  if (!haveTiltRef) {
    lastLoggedRoll  = currentRoll;
    lastLoggedPitch = currentPitch;
    haveTiltRef = true;
    lastTiltLog = millis();
    return;
  }

  if (millis() - lastTiltLog < TILT_MIN_GAP_MS) return;

  float dRoll  = fabs(currentRoll  - lastLoggedRoll);
  float dPitch = fabs(currentPitch - lastLoggedPitch);

  // Roll wraps at +/-180, so 179 -> -179 is a 2 degree change, not 358
  if (dRoll > 180) dRoll = 360 - dRoll;

  if (dRoll < TILT_CHANGE_DEG && dPitch < TILT_CHANGE_DEG) return;

  bool alert = (fabs(currentRoll)  > TILT_ALERT_DEG ||
                fabs(currentPitch) > TILT_ALERT_DEG);

  Serial.print(F("TILT    change roll "));
  Serial.print(dRoll, 1);
  Serial.print(F(" deg, pitch "));
  Serial.print(dPitch, 1);
  Serial.print(F(" deg -> now R:"));
  Serial.print(currentRoll, 1);
  Serial.print(F(" P:"));
  Serial.print(currentPitch, 1);
  Serial.println(alert ? F("  ** ALERT **") : F(""));

  // Parked rows carry the averaged position; moving rows carry the live one
  captureReading(motionState == PARKED);
  lastTiltLog = millis();

  // A genuine handling event should not wait for the next 30 s flush
  if (alert) flushBuffer();
}

// =====================================================
//  LOGGING RULES
// =====================================================
bool gpsUsable() {
  if (!gps.location.isValid())                return false;
  if (gps.location.age() > FIX_MAX_AGE)        return false;
  if (!gps.satellites.isValid())               return false;
  if (gps.satellites.value() < MIN_SATS)       return false;
  if (gps.hdop.isValid() && gps.hdop.hdop() > MAX_HDOP) return false;
  return true;
}

void handleMoving() {
  if (millis() - lastMovingCheck < MOVING_SAMPLE_MS) return;
  lastMovingCheck = millis();

  if (!gpsUsable()) return;

  // Doppler speed is independent of position error - trust it over coordinates
  float spd = gps.speed.isValid() ? gps.speed.kmph() : 0;

  double lat = gps.location.lat();
  double lng = gps.location.lng();
  float  hdg = gps.course.isValid() ? gps.course.deg() : -1;

  bool shouldLog = false;

  if (!haveLastLogged) {
    shouldLog = true;                       // first point of this trip
  } else {
    float dist = haversineM(lastLoggedLat, lastLoggedLng, lat, lng);
    float turn = 0;
    if (hdg >= 0 && lastLoggedHeading >= 0) {
      turn = fabs(hdg - lastLoggedHeading);
      if (turn > 180) turn = 360 - turn;    // wrap around north
    }

    if (dist >= MIN_DISTANCE_M && spd >= STATIONARY_KMPH) shouldLog = true;
    if (turn >= MIN_HEADING_DEG && spd >= STATIONARY_KMPH) shouldLog = true;
    if (millis() - lastLogTime >= MOVING_MAX_GAP_MS)       shouldLog = true;
  }

  if (shouldLog) {
    captureReading(false);
    lastLoggedLat = lat;
    lastLoggedLng = lng;
    lastLoggedHeading = hdg;
    haveLastLogged = true;
    lastLogTime = millis();
  }
}

void handleParked() {
  // Keep averaging the position while we sit still, so the parked fix ends
  // up better than any single reading.
  //
  // isUpdated() is the important part: loop() runs thousands of times a
  // second but the GPS only produces a new fix about once a second. Without
  // it, the same fix would be added thousands of times over.
  if (gps.location.isUpdated() && gpsUsable()) {
    double lat = gps.location.lat();   // reading lat() clears isUpdated()
    double lng = gps.location.lng();

    if (parkSamples < PARK_AVG_WARMUP) parkSamples++;
    double w = 1.0 / parkSamples;      // 1, 1/2, 1/3 ... 1/100, then stays 1/100
    parkLat += w * (lat - parkLat);    // n=1 -> w=1, so the first fix seeds it
    parkLng += w * (lng - parkLng);
  }

  if (millis() - lastLogTime >= PARKED_HEARTBEAT) {
    captureReading(true);
    lastLogTime = millis();
  }
}

// useAverage: true while parked, so we send the averaged position
void captureReading(bool useAverage) {
  if (bufCount >= BUFFER_SIZE) {
    // Buffer full and upload failing - drop the oldest to keep the newest
    for (uint8_t i = 1; i < BUFFER_SIZE; i++) buffer[i - 1] = buffer[i];
    bufCount = BUFFER_SIZE - 1;
    droppedRows++;
  }

  Reading &r = buffer[bufCount];

  float ax = 0, ay = 0, az = 0, gx = 0, gy = 0, gz = 0, t = 0;
  if (imuAddr != 0) imuRead(ax, ay, az, gx, gy, gz, t);

  // Use the 20 Hz orientation already being tracked, not a fresh one-shot
  // read - it is smoother and matches what the tilt trigger acted on.
  r.roll   = currentRoll;
  r.pitch  = currentPitch;
  r.tempC  = t;
  r.moving = (motionState == MOVING);
  r.rssi   = WiFi.RSSI();
  r.epoch  = gpsEpoch();

  // Every logged row becomes the new tilt reference, whatever triggered it.
  // Without this, a heartbeat row would leave the old reference in place and
  // the next tilt check would re-fire on a change that was already recorded.
  lastLoggedRoll  = currentRoll;
  lastLoggedPitch = currentPitch;
  haveTiltRef     = true;
  lastTiltLog     = millis();

  if (useAverage && parkSamples > 0) {
    r.lat = parkLat;
    r.lng = parkLng;
    r.gpsValid = true;
    r.sats  = gps.satellites.isValid() ? gps.satellites.value() : 0;
    r.hdop  = gps.hdop.isValid() ? gps.hdop.hdop() : 0;
    r.speed = 0;
    r.heading = -1;                 // stationary, heading is meaningless
  } else if (gpsUsable()) {
    r.lat = gps.location.lat();
    r.lng = gps.location.lng();
    r.gpsValid = true;
    r.sats  = gps.satellites.value();
    r.hdop  = gps.hdop.isValid() ? gps.hdop.hdop() : 0;
    r.speed = gps.speed.isValid() ? gps.speed.kmph() : 0;
    r.heading = gps.course.isValid() ? gps.course.deg() : -1;
  } else {
    r.lat = 0; r.lng = 0;
    r.gpsValid = false;
    r.sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
    r.hdop = 0;
    r.speed = 0;
    r.heading = -1;
  }

  bufCount++;

  Serial.print(F("LOG     buffered ")); Serial.print(bufCount);
  Serial.print('/'); Serial.print(BUFFER_SIZE);
  Serial.print(F("  ")); Serial.println(r.gpsValid ? F("with fix") : F("no fix"));
}

// =====================================================
//  UPLOAD - one POST carries the whole buffer
// =====================================================
void flushBuffer() {
  if (bufCount == 0) return;

  if (WiFi.status() != WL_CONNECTED) {
    wifiConnect();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println(F("UPLOAD  WiFi down - keeping rows buffered"));
      lastUpload = millis();     // back off, do not spin
      uploadFail++;
      return;
    }
  }

  // PostgREST requires EVERY object in a bulk-insert array to carry the
  // SAME set of keys. Omitting a key on some rows gives:
  //   400 PGRST102 "All object keys must match"
  // So every row below emits every key, using null where there is no value.
  //
  // recorded_at is the one exception: it cannot be null (NOT NULL with a
  // default), so if ANY row in this batch lacks a GPS timestamp we drop the
  // field from ALL rows and let the server stamp them with now().
  bool allHaveTime = true;
  for (uint8_t i = 0; i < bufCount; i++) {
    if (buffer[i].epoch == 0) { allHaveTime = false; break; }
  }

  String body = "[";
  for (uint8_t i = 0; i < bufCount; i++) {
    Reading &r = buffer[i];
    if (i) body += ',';
    body += "{\"device_id\":\""; body += DEVICE_ID; body += "\"";

    if (allHaveTime) {
      body += ",\"recorded_at\":\""; body += isoTime(r.epoch); body += "\"";
    }

    body += ",\"gps_valid\":"; body += r.gpsValid ? "true" : "false";
    body += ",\"is_moving\":"; body += r.moving ? "true" : "false";

    // Always present, null when unknown
    body += ",\"lat\":";        body += r.gpsValid ? String(r.lat, 6) : String("null");
    body += ",\"lng\":";        body += r.gpsValid ? String(r.lng, 6) : String("null");
    body += ",\"sats\":";       body += r.sats > 0 ? String(r.sats) : String("null");
    body += ",\"speed_kmph\":"; body += r.gpsValid ? String(r.speed, 2) : String("null");
    body += ",\"hdop\":";       body += r.hdop > 0 ? String(r.hdop, 2) : String("null");
    body += ",\"heading\":";    body += r.heading >= 0 ? String(r.heading, 1) : String("null");
    body += ",\"roll\":";       body += String(r.roll, 2);
    body += ",\"pitch\":";      body += String(r.pitch, 2);
    body += ",\"temp_c\":";     body += String(r.tempC, 2);
    body += ",\"rssi\":";       body += r.rssi;
    body += "}";
  }
  body += "]";

  HTTPClient http;
  http.begin(secureClient, String(SUPABASE_URL) + "/rest/v1/readings");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey",        SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer",        "return=minimal");
  // Keep this short. The POST blocks, and while it blocks SoftwareSerial
  // drops incoming GPS bytes - which is why a long upload shows up as a
  // "stale" GPS fix immediately afterwards. 8 s is enough for a good link
  // and fails fast on a bad one.
  http.setTimeout(8000);

  int code = http.POST(body);

  if (code == 201 || code == 200) {
    uploadOK++;
    Serial.print(F("UPLOAD  OK - ")); Serial.print(bufCount);
    Serial.print(F(" rows  (")); Serial.print(uploadOK);
    Serial.print(F(" ok / ")); Serial.print(uploadFail); Serial.println(F(" fail)"));
    bufCount = 0;                       // only clear on success
  } else {
    uploadFail++;
    Serial.print(F("UPLOAD  FAILED HTTP ")); Serial.println(code);
    String resp = http.getString();
    if (resp.length()) { Serial.print(F("        ")); Serial.println(resp); }
    if (code == 401) Serial.println(F("        -> check SUPABASE_KEY"));
    if (code == 404) Serial.println(F("        -> run the SQL script"));
    // Rows stay in the buffer and go out with the next attempt
  }

  http.end();
  lastUpload = millis();
}

// =====================================================
//  HELPERS
// =====================================================

// Great-circle distance in metres
float haversineM(double lat1, double lon1, double lat2, double lon2) {
  const float R = 6371000.0;
  float dLat = radians(lat2 - lat1);
  float dLon = radians(lon2 - lon1);
  float a = sin(dLat / 2) * sin(dLat / 2) +
            cos(radians(lat1)) * cos(radians(lat2)) *
            sin(dLon / 2) * sin(dLon / 2);
  return R * 2 * atan2(sqrt(a), sqrt(1 - a));
}

// GPS UTC as a unix epoch, or 0 if we do not have the time yet
uint32_t gpsEpoch() {
  if (!gps.date.isValid() || !gps.time.isValid()) return 0;
  if (gps.date.year() < 2020) return 0;

  struct tm t;
  memset(&t, 0, sizeof(t));
  t.tm_year = gps.date.year() - 1900;
  t.tm_mon  = gps.date.month() - 1;
  t.tm_mday = gps.date.day();
  t.tm_hour = gps.time.hour();
  t.tm_min  = gps.time.minute();
  t.tm_sec  = gps.time.second();
  return (uint32_t)mktime(&t);     // ESP8266 runs in UTC by default
}

String isoTime(uint32_t epoch) {
  time_t tt = (time_t)epoch;
  struct tm *t = gmtime(&tt);
  char buf[26];
  sprintf(buf, "%04d-%02d-%02dT%02d:%02d:%02dZ",
          t->tm_year + 1900, t->tm_mon + 1, t->tm_mday,
          t->tm_hour, t->tm_min, t->tm_sec);
  return String(buf);
}

void updateLed() {
  bool fix = gpsUsable();
  if (fix) {
    // Fast blink while moving, slow while parked - readable at a glance
    unsigned long period = (motionState == MOVING) ? 200 : BLINK_MS;
    if (millis() - lastBlink >= period) {
      lastBlink = millis();
      ledLit = !ledLit;
      digitalWrite(LED_PIN, ledLit ? LED_ON : LED_OFF);
    }
  } else if (ledLit) {
    ledLit = false;
    digitalWrite(LED_PIN, LED_OFF);
  }
}

void wifiConnect() {
  Serial.print(F("[..]   WiFi connecting"));
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print('.');
    while (gpsSerial.available() > 0) gps.encode(gpsSerial.read());
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("[OK]   WiFi up, IP ")); Serial.println(WiFi.localIP());
  } else {
    Serial.println(F("[FAIL] WiFi timeout"));
  }
}

// =====================================================
//  IMU
// =====================================================
void imuInit() {
  uint8_t candidates[2] = {0x68, 0x69};
  for (uint8_t i = 0; i < 2; i++) {
    uint8_t addr = candidates[i];
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) continue;

    imuWho = regRead(addr, REG_WHO_AM_I);
    imuAddr = addr;
    Serial.print(F("[OK]   IMU at 0x")); Serial.print(addr, HEX);
    Serial.print(F("  WHO_AM_I 0x")); Serial.print(imuWho, HEX);
    Serial.print(F(" -> "));
    switch (imuWho) {
      case 0x68: Serial.println(F("MPU-6050")); isMPU6050 = true;  break;
      case 0x70: Serial.println(F("MPU-6500")); isMPU6050 = false; break;
      case 0x71: Serial.println(F("MPU-9250")); isMPU6050 = false; break;
      case 0x73: Serial.println(F("MPU-9255")); isMPU6050 = false; break;
      default:   Serial.println(F("unknown - trying anyway")); break;
    }
    break;
  }

  if (imuAddr == 0) {
    Serial.println(F("[FAIL] No IMU - motion detection disabled"));
    return;
  }

  regWrite(imuAddr, REG_PWR_MGMT_1, 0x80); delay(100);
  regWrite(imuAddr, REG_PWR_MGMT_1, 0x01); delay(50);
  regWrite(imuAddr, REG_CONFIG,       0x03);
  regWrite(imuAddr, REG_SMPLRT_DIV,   0x09);
  regWrite(imuAddr, REG_GYRO_CONFIG,  0x00);
  regWrite(imuAddr, REG_ACCEL_CONFIG, 0x08);
  delay(50);
  Serial.println(F("[OK]   IMU configured"));
}

void imuRead(float &ax, float &ay, float &az,
             float &gx, float &gy, float &gz, float &tempC) {
  uint8_t buf[14];
  Wire.beginTransmission(imuAddr);
  Wire.write(REG_ACCEL_XOUT_H);
  Wire.endTransmission(false);
  Wire.requestFrom(imuAddr, (uint8_t)14);
  for (uint8_t i = 0; i < 14 && Wire.available(); i++) buf[i] = Wire.read();

  int16_t rawAx = (buf[0] << 8) | buf[1];
  int16_t rawAy = (buf[2] << 8) | buf[3];
  int16_t rawAz = (buf[4] << 8) | buf[5];
  int16_t rawT  = (buf[6] << 8) | buf[7];
  int16_t rawGx = (buf[8] << 8) | buf[9];
  int16_t rawGy = (buf[10] << 8) | buf[11];
  int16_t rawGz = (buf[12] << 8) | buf[13];

  ax = rawAx / ACCEL_LSB; ay = rawAy / ACCEL_LSB; az = rawAz / ACCEL_LSB;
  gx = rawGx / GYRO_LSB;  gy = rawGy / GYRO_LSB;  gz = rawGz / GYRO_LSB;
  tempC = isMPU6050 ? (rawT / 340.0f) + 36.53f : (rawT / 333.87f) + 21.0f;
}

void regWrite(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg); Wire.write(val);
  Wire.endTransmission();
}

uint8_t regRead(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}

// =====================================================
void printStatus() {
  Serial.println(F("--------------------------------"));

  Serial.print(F("STATE  "));
  Serial.print(motionState == MOVING ? F("MOVING ") : F("PARKED "));
  Serial.print(F(" variance:"));
  Serial.print(currentVariance, 5);
  Serial.print(F("  (needs "));
  Serial.print(motionState == PARKED ? MOTION_ENTER : MOTION_EXIT, 4);
  Serial.println(motionState == PARKED ? F(" to start)") : F(" to stop)"));

  Serial.print(F("TILT   roll:"));  Serial.print(currentRoll, 1);
  Serial.print(F(" pitch:"));       Serial.print(currentPitch, 1);
  Serial.print(F("  (ref R:"));     Serial.print(lastLoggedRoll, 1);
  Serial.print(F(" P:"));           Serial.print(lastLoggedPitch, 1);
  Serial.print(F(")  logs at "));   Serial.print(TILT_CHANGE_DEG, 0);
  Serial.println(F(" deg"));

  Serial.print(F("GPS    "));
  if (gpsUsable()) {
    Serial.print(F("OK  ")); Serial.print(gps.location.lat(), 6);
    Serial.print(F(", "));   Serial.print(gps.location.lng(), 6);
    Serial.print(F("  spd:")); Serial.print(gps.speed.kmph(), 1);
  } else {
    Serial.print(F("rejected - "));
    if (!gps.location.isValid())                     Serial.print(F("no fix"));
    else if (gps.location.age() > FIX_MAX_AGE)       Serial.print(F("stale"));
    else if (!gps.satellites.isValid() ||
             gps.satellites.value() < MIN_SATS)      Serial.print(F("too few sats"));
    else if (gps.hdop.isValid() &&
             gps.hdop.hdop() > MAX_HDOP)             Serial.print(F("HDOP too high"));
  }
  Serial.print(F("  sats:"));
  Serial.print(gps.satellites.isValid() ? gps.satellites.value() : 0);
  Serial.print(F("  hdop:"));
  Serial.println(gps.hdop.isValid() ? gps.hdop.hdop() : 0, 1);

  Serial.print(F("BUF    ")); Serial.print(bufCount);
  Serial.print('/'); Serial.print(BUFFER_SIZE);
  Serial.print(F("  uploads ")); Serial.print(uploadOK);
  Serial.print('/'); Serial.print(uploadFail);
  if (droppedRows) { Serial.print(F("  dropped:")); Serial.print(droppedRows); }
  Serial.print(F("  heap:")); Serial.println(ESP.getFreeHeap());
  Serial.println();
}

void i2cScan() {
  Serial.println(F("I2C scan..."));
  byte count = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("  device at 0x"));
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      count++;
    }
  }
  if (count == 0) Serial.println(F("  none found"));
  Serial.println();
}