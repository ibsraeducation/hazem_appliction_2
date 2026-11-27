import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import { AppState, Linking, Modal, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { viewerHtml, type PicSize } from '../lib/viewerHtml';
import { CAMERA_IP, connectToCamera, currentSsid, ensureOnCamera } from '../lib/camWifi';
import { holdWifi, releaseWifiLock } from '../lib/wifiLock';
import { codeFor, helpFor, type Action, type ErrorCode } from '../lib/errorHelp';
import LoadingOverlay, { type Phase } from '../components/LoadingOverlay';
import ErrorScreen from '../components/ErrorScreen';
import TestResults from '../components/TestResults';
import { playClip, preloadClips, stopClips, type Clip } from '../lib/sounds';
import { reportText, type TestResult } from '../lib/speedTest';
import { colors } from '../theme';

// connecting → live ⇄ reconnecting → error → (Try again) connecting.  stopped = user pressed Stop.
// testing = speed test running (normal video paused; the camera serves one connection).
type State = 'stopped' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'testing';

const HARD_LIMIT_MS = 45000; // the loader never spins longer than this
const TEST_LIMIT_MS = 120000; // the speed test never runs longer than this
const MAX_LOG = 60;

export default function LiveScreen() {
  useKeepAwake(); // a sleeping screen would cut the stream

  const [host, setHost] = useState(CAMERA_IP);
  const [state, setState] = useState<State>('connecting');
  const [errCode, setErrCode] = useState<ErrorCode>('other');
  const [active, setActive] = useState(false); // viewer page running
  const [nonce, setNonce] = useState(0); // fresh WebView => old sockets dropped
  const [phase, setPhase] = useState<Phase | null>(null);
  const [step, setStep] = useState('');
  const [fps, setFps] = useState(0);
  const [via, setVia] = useState('');
  const [slow, setSlow] = useState(false); // photo is late (camera slow), picture still shown
  const [pref, setPref] = useState<string | null>(null);
  const [size, setSize] = useState<PicSize>('small'); // smaller picture = more fps
  const [sizeCode, setSizeCode] = useState<string | null>(null); // camera command that worked
  const [res, setRes] = useState('');
  const [testMode, setTestMode] = useState(false);
  const [testRes, setTestRes] = useState<TestResult | null>(null);
  const web = useRef<any>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const resumeOnReturn = useRef(false);
  const retryOnReturn = useRef(false);
  const logs = useRef<string[]>([]);
  const addLog = (s: string) => {
    logs.current.push(s);
    if (logs.current.length > MAX_LOG) logs.current.shift();
  };

  // ---------- settings (saved on the phone) ----------
  const [avoid, setAvoid] = useState(true);
  const [alarm, setAlarm] = useState(40); // alarm when a part's closeness reaches this %
  const [levels, setLevels] = useState<number[]>([0, 0, 0]); // closeness % left / front / right
  const [showSettings, setShowSettings] = useState(false);
  const [calMsg, setCalMsg] = useState('');
  const [rot, setRot] = useState(0);
  const [flip, setFlip] = useState(true); // the camera image arrives mirrored: flip it back by default
  const [blocked, setBlocked] = useState<number[]>([0, 0, 0]);
  const avoidRef = useRef(avoid);
  avoidRef.current = avoid;

  const loaded = useRef<Promise<void> | null>(null);
  if (!loaded.current) {
    loaded.current = AsyncStorage.multiGet(['rot', 'alarm', 'flip', 'method', 'size', 'sizeCode'])
      .then((kv) => {
        const g = (k: string) => kv.find((x) => x[0] === k)?.[1];
        if (g('rot')) setRot(Number(g('rot')));
        if (g('flip')) setFlip(g('flip') === '1');
        if (g('alarm')) setAlarm(Number(g('alarm')));
        if (g('method')) setPref(g('method') ?? null);
        const sz = g('size');
        if (sz === 'small' || sz === 'medium' || sz === 'large') setSize(sz);
        if (g('sizeCode')) setSizeCode(g('sizeCode') ?? null);
      })
      .catch(() => {});
  }

  // Works like an ultrasonic alarm: each part shows a closeness % (more of it covered = closer),
  // and the warning plays when a part reaches the alarm %.
  const changeAlarm = (p: number) => {
    const v = Math.max(5, Math.min(95, Math.round(p / 5) * 5));
    setAlarm(v);
    setCalMsg('');
    AsyncStorage.setItem('alarm', String(v)).catch(() => {});
  };
  const clearView = () => {
    web.current?.injectJavaScript('window.resetRef&&window.resetRef();true;');
    setCalMsg('Clear view saved');
  };
  // Stand where the alarm should start and press: the alarm % becomes the closeness measured now.
  const useCurrent = () => {
    const now = Math.max(...levels);
    if (now < 10) {
      setCalMsg('Nothing in front of the camera now. Stand where the alarm should start and try again.');
      return;
    }
    changeAlarm(now - 5);
    setCalMsg(`Alarm set to ${Math.max(5, Math.round((now - 5) / 5) * 5)}% (measured ${now}%)`);
  };
  const rotate = () => {
    const r = (rot + 90) % 360;
    setRot(r);
    AsyncStorage.setItem('rot', String(r)).catch(() => {});
  };
  const toggleFlip = (v: boolean) => {
    setFlip(v);
    AsyncStorage.setItem('flip', v ? '1' : '0').catch(() => {});
  };
  const changeSize = (v: PicSize) => {
    if (v === size) return;
    setSize(v);
    setSizeCode(null);
    setRes('');
    AsyncStorage.setItem('size', v).catch(() => {});
    AsyncStorage.removeItem('sizeCode').catch(() => {});
    if (active) setNonce((n) => n + 1); // reload the viewer with the new size
  };
  const sendView = useCallback(() => {
    web.current?.injectJavaScript(
      `window.ALARM=${alarm / 100};window.DBG=${showSettings ? 1 : 0};window.setView&&window.setView(${rot},${flip});true;`,
    );
  }, [alarm, rot, flip, showSettings]);
  useEffect(() => {
    sendView();
  }, [sendView]);

  // ---------- voice ----------
  const [dbg, setDbg] = useState('');
  const [voiceMsg, setVoiceMsg] = useState('');
  const voiceId = useRef<string | undefined>(undefined);
  const speaking = useRef(false);

  // Speak with an installed Arabic voice; if that fails, retry with the phone's default Arabic.
  const say = useCallback((text: string, retry = false) => {
    speaking.current = true;
    const done = () => {
      speaking.current = false;
    };
    Speech.speak(text, {
      language: 'ar',
      voice: retry ? undefined : voiceId.current,
      rate: 0.95,
      volume: 1,
      onStart: () => setVoiceMsg('Speaking...'),
      onDone: () => {
        done();
        setVoiceMsg('Sound OK');
      },
      onStopped: done,
      onError: (e) => {
        done();
        if (!retry) say(text, true);
        else setVoiceMsg(`Speech error: ${String((e as any)?.message ?? e)}`);
      },
    });
    // If nothing starts within 3 s, free the lock so the next warning can try again.
    setTimeout(() => {
      if (speaking.current) Speech.isSpeakingAsync().then((s) => !s && done()).catch(done);
    }, 3000);
  }, []);

  const pickVoice = useCallback(async () => {
    const voices = await Speech.getAvailableVoicesAsync();
    const ar = voices.filter((v) => v.language.toLowerCase().startsWith('ar'));
    voiceId.current = (ar.find((v) => !(v as any).notInstalled) ?? ar[0])?.identifier;
    return ar.length;
  }, []);
  useEffect(() => {
    pickVoice().catch(() => {});
  }, [pickVoice]);

  // The recorded clips are played first; the phone's own voice is only the backup.
  const TEXT: Record<Clip, string> = {
    left: 'احترس , يوجد شئ امامك اتجاه اليسار',
    right: 'احترس , يوجد شئ امامك اتجاه اليمين',
    front: 'احترس , يوجد شئ امامك مباشرتا',
  };
  const announce = useCallback(
    (k: Clip) => {
      speaking.current = true;
      playClip(k).then((ok) => {
        if (ok) {
          speaking.current = false;
          setVoiceMsg('Sound OK');
        } else {
          addLog('recorded sound failed: using the phone voice');
          say(TEXT[k]);
        }
      });
    },
    [say], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    preloadClips();
  }, []);

  const testVoice = useCallback(async () => {
    Speech.stop();
    stopClips();
    setVoiceMsg('Playing: left, right, front...');
    for (const k of ['left', 'right', 'front'] as Clip[]) {
      const ok = await playClip(k);
      if (!ok) {
        try {
          const n = await pickVoice();
          setVoiceMsg(n ? 'Recorded sound did not play. Using the phone voice.' : 'Sound did not play and no Arabic voice is installed.');
        } catch {
          setVoiceMsg('Sound did not play.');
        }
        say(TEXT[k]);
        return;
      }
    }
    setVoiceMsg('Sound OK (left, right, front)');
  }, [say, pickVoice]); // eslint-disable-line react-hooks/exhaustive-deps

  const warn = useCallback(
    (b: number[]) => {
      if (!avoidRef.current || !b.some(Boolean) || speaking.current) return;
      const [l, c, r] = b;
      announce(c || (l && r) ? 'front' : l ? 'left' : 'right');
    },
    [announce],
  );

  // While something stays in the way, repeat the warning every 4 seconds.
  const showingPicture = state === 'live';
  useEffect(() => {
    if (!avoid || !showingPicture || !blocked.some(Boolean)) return;
    const t = setInterval(() => warn(blocked), 4000);
    return () => clearInterval(t);
  }, [avoid, showingPicture, blocked, warn]);
  useEffect(() => {
    if (!avoid || !showingPicture) {
      Speech.stop();
      stopClips();
      setBlocked([0, 0, 0]);
      setLevels([0, 0, 0]);
    }
  }, [avoid, showingPicture]);

  // ---------- connection ----------
  const fail = useCallback((code: ErrorCode) => {
    addLog(`error: ${code}`);
    setTestMode(false);
    setActive(false); // closes the viewer => frees the single-connection camera
    setErrCode(code);
    setState('error');
  }, []);

  const stop = useCallback(() => {
    setActive(false);
    setState('stopped');
    setNonce((n) => n + 1);
  }, []);

  const start = useCallback(async () => {
    setActive(false);
    setTestMode(false);
    setState('connecting');
    setPhase(null);
    setFps(0);
    setStep('Checking Wi-Fi...');
    setNonce((n) => n + 1);
    await loaded.current;
    try {
      await connectToCamera(setStep); // join camera Wi-Fi automatically
    } catch (e) {
      const code = codeFor((e as Error).message ?? String(e));
      // Test version (Expo Go) can't switch Wi-Fi: go on, the camera check below tells the user if needed.
      if (code !== 'expo-go') {
        if (stateRef.current === 'connecting') fail(code);
        return;
      }
    }
    if (stateRef.current !== 'connecting') return; // cancelled meanwhile
    setStep('Checking camera connection');
    setNonce((n) => n + 1);
    setActive(true);
  }, [fail]);

  // ---------- speed test ----------
  // The viewer is reloaded in test mode (normal video stops: the camera serves one connection),
  // then reloaded normally when the result arrives.
  const runTest = () => {
    setShowSettings(false);
    setTestRes(null);
    setPhase(null);
    addLog('speed test started');
    setTestMode(true);
    setState('testing');
    setNonce((n) => n + 1);
  };
  const resumeAfterTest = () => {
    setTestMode(false);
    setPhase(null);
    setState('connecting');
    setNonce((n) => n + 1);
  };
  useEffect(() => {
    if (state !== 'testing') return;
    const t = setTimeout(() => {
      addLog('speed test took too long');
      setTestMode(false);
      setState('connecting');
      setNonce((n) => n + 1);
    }, TEST_LIMIT_MS);
    return () => clearTimeout(t);
  }, [state]);

  // Start as soon as the app opens; lock landscape.
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    start();
  }, [start]);

  // The loader never spins forever.
  useEffect(() => {
    if (state !== 'connecting') return;
    const t = setTimeout(() => fail('timeout'), HARD_LIMIT_MS);
    return () => clearTimeout(t);
  }, [state, nonce, fail]);

  // Leaving the app frees the camera; coming back resumes (or retries after "Open Wi-Fi settings").
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') {
        if (['live', 'reconnecting', 'connecting', 'testing'].includes(stateRef.current)) {
          resumeOnReturn.current = true;
          setActive(false);
        }
      } else if (st === 'active' && (resumeOnReturn.current || retryOnReturn.current)) {
        resumeOnReturn.current = false;
        retryOnReturn.current = false;
        start();
      }
    });
    return () => sub.remove();
  }, [start]);

  // Low-latency Wi-Fi (no power-save delays) while the camera is shown.
  useEffect(() => {
    if (!active) return;
    addLog(holdWifi() ? 'wifi low-latency lock on' : 'wifi lock not available');
    return () => releaseWifiLock();
  }, [active]);

  // Wi-Fi watchdog (installed app only): if Android moves the phone off the camera Wi-Fi, rejoin.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      ensureOnCamera()
        .then((ok) => {
          if (!ok && stateRef.current !== 'error' && stateRef.current !== 'testing') {
            addLog('wifi watchdog: phone left the camera Wi-Fi');
            setState('reconnecting');
            setNonce((n) => n + 1);
          }
        })
        .catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [active]);

  const onAction = useCallback(
    (a: Action) => {
      if (a === 'retry') start();
      else if (a === 'wifi') {
        retryOnReturn.current = true;
        Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() => Linking.openSettings());
      } else if (a === 'appSettings') {
        retryOnReturn.current = true;
        Linking.openSettings();
      } else if (a === 'cameraPage') Linking.openURL(`http://${host.trim()}`).catch(() => {});
    },
    [start, host],
  );

  const html = useMemo(() => viewerHtml(host.trim(), active, pref, size, sizeCode, testMode), [host, active, nonce]);
  const source = useMemo(() => ({ html, baseUrl: `http://${host.trim()}/` }), [html]); // eslint-disable-line react-hooks/exhaustive-deps // eslint-disable-line react-hooks/exhaustive-deps

  const onMessage = (e: { nativeEvent: { data: string } }) => {
    let m: { type: string; msg: string };
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    try {
      switch (m.type) {
        case 'phase':
          setPhase(JSON.parse(m.msg));
          break;
        case 'streaming':
          setVia(m.msg);
          setSlow(false);
          setState('live');
          break;
        case 'slow':
          setSlow(true);
          break;
        case 'ok':
          setSlow(false);
          break;
        case 'reconnecting':
          setSlow(false);
          setState('reconnecting');
          // tells apart "phone left the camera Wi-Fi" from "camera went silent"
          currentSsid()
            .then((ssid) => addLog(`reconnecting - phone Wi-Fi: ${ssid ?? 'unknown'}`))
            .catch(() => {});
          break;
        case 'method':
          if (m.msg !== pref) {
            setPref(m.msg);
            AsyncStorage.setItem('method', m.msg).catch(() => {});
          }
          break;
        case 'fps':
          setFps(Number(m.msg) || 0);
          break;
        case 'test':
          setTestRes(JSON.parse(m.msg) as TestResult);
          addLog('speed test done');
          resumeAfterTest();
          break;
        case 'res':
          setRes(m.msg);
          break;
        case 'size':
          if (m.msg === 'none') addLog('camera kept its own picture size');
          if (m.msg !== sizeCode) {
            setSizeCode(m.msg);
            AsyncStorage.setItem('sizeCode', m.msg).catch(() => {});
          }
          break;
        case 'log':
          addLog(m.msg);
          break;
        case 'dbg':
          setDbg(m.msg);
          break;
        case 'obs': {
          const o = JSON.parse(m.msg) as { b: number[] };
          setBlocked(o.b);
          if (stateRef.current === 'live') warn(o.b);
          break;
        }
        case 'lvl':
          setLevels(JSON.parse(m.msg) as number[]);
          break;
        case 'error': {
          const code = codeFor(m.msg);
          if (code === 'novideo') {
            setPref(null); // the remembered method didn't work: forget it
            AsyncStorage.removeItem('method').catch(() => {});
          }
          fail(code);
          break;
        }
      }
    } catch {
      // a malformed message must never break the screen
    }
  };

  const shareLog = () => {
    Share.share({ message: `AiPi Cam diagnostics\nstate: ${state}\nmethod: ${pref ?? '-'}\nsize: ${size} (${res || '-'}, code ${sizeCode ?? '-'})\n\n${logs.current.join('\n')}` }).catch(
      () => {},
    );
  };

  const statusText =
    state === 'live'
      ? `Live${fps ? ` - ${fps} fps` : ''}${res ? ` - ${res}` : ''}${via === 'photos' ? ' (photo mode, slow)' : ''}`
      : state === 'reconnecting'
        ? 'Reconnecting...'
        : state === 'connecting'
          ? 'Connecting...'
          : state === 'testing'
            ? 'Speed test...'
            : state === 'error'
            ? 'Not connected'
            : 'Stopped';
  const statusColor = state === 'live' ? colors.ok : state === 'error' ? colors.bad : colors.dim;
  const running = state === 'live' || state === 'reconnecting' || state === 'connecting' || state === 'testing';

  return (
    <View style={s.root}>
      <View style={s.viewer}>
        <WebView
          ref={web}
          onLoadEnd={sendView}
          key={nonce}
          source={source}
          originWhitelist={['*']}
          mixedContentMode="always"
          javaScriptEnabled
          cacheEnabled={false}
          androidLayerType="hardware"
          style={s.web}
          onMessage={onMessage}
          onRenderProcessGone={() => {
            addLog('webview crashed');
            start();
          }}
        />
        {avoid && state === 'live' && (
          <View style={s.zones} pointerEvents="none">
            {['Left', 'Front', 'Right'].map((n, i) => {
              const p = levels[i] ?? 0;
              const col = blocked[i] ? colors.bad : p >= alarm * 0.7 ? '#f59e0b' : colors.ok;
              return (
                <View key={n} style={[s.zone, blocked[i] ? s.zoneBad : null]}>
                  <View style={s.meter}>
                    <View style={[s.meterFill, { height: `${Math.min(100, p)}%`, backgroundColor: col }]} />
                    <View style={[s.meterMark, { bottom: `${alarm}%` }]} />
                  </View>
                  <Text style={[s.zonePct, { color: col }]}>{p}%</Text>
                  <Text style={s.zoneText}>{n}</Text>
                </View>
              );
            })}
          </View>
        )}
        {state === 'stopped' && (
          <View style={s.stoppedBox} pointerEvents="none">
            <Text style={s.stoppedText}>Stopped. Tap Start to show the camera.</Text>
          </View>
        )}
        {slow && state === 'live' && (
          <View style={s.slowPill} pointerEvents="none">
            <Text style={s.slowText}>Camera slow - waiting for next picture...</Text>
          </View>
        )}
        <LoadingOverlay
          visible={state === 'reconnecting'}
          reconnecting
          phase={null}
          step=""
          attempt={0}
          onCancel={stop}
        />
      </View>

      <View style={s.side}>
        <Text style={[s.status, { color: statusColor }]}>{statusText}</Text>

        <View style={s.switchRow}>
          <Text style={s.label}>Obstacle alert</Text>
          <Switch value={avoid} onValueChange={setAvoid} />
        </View>
        <Pressable style={s.testBtn} onPress={() => setShowSettings(true)}>
          <Text style={s.btnText}>Settings (alarm {alarm}%)</Text>
        </Pressable>

        <View style={s.row}>
          <TextInput
            style={s.input}
            value={host}
            onChangeText={setHost}
            editable={!running}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
          />
          <Pressable style={[s.btn, running && s.btnStop]} onPress={running ? stop : start}>
            <Text style={s.btnText}>{running ? 'Stop' : 'Start'}</Text>
          </Pressable>
        </View>
      </View>

      {/* Full-screen loader for the first picture */}
      <LoadingOverlay
        visible={state === 'connecting' || state === 'testing'}
        reconnecting={false}
        phase={phase}
        step={state === 'testing' ? 'Speed test - please wait' : step}
        attempt={nonce}
        onCancel={stop}
      />

      {state === 'error' && <ErrorScreen help={helpFor(errCode)} onAction={onAction} />}

      {testRes && state !== 'testing' && (
        <TestResults
          result={testRes}
          onUse={(v) => {
            changeSize(v);
            setTestRes(null);
          }}
          onShare={() => Share.share({ message: reportText(testRes) }).catch(() => {})}
          onClose={() => setTestRes(null)}
        />
      )}

      <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
        <View style={s.backdrop}>
          <ScrollView style={[s.dialog, s.settings]} contentContainerStyle={{ gap: 10 }}>
            <Text style={s.dTitle}>Settings</Text>

            <Text style={s.label}>Alarm when closeness reaches</Text>
            <View style={s.row}>
              <Pressable style={s.stepBtn} onPress={() => changeAlarm(alarm - 5)}>
                <Text style={s.btnText}>-</Text>
              </Pressable>
              <Text style={s.distText}>{alarm}%</Text>
              <Pressable style={s.stepBtn} onPress={() => changeAlarm(alarm + 5)}>
                <Text style={s.btnText}>+</Text>
              </Pressable>
            </View>
            <Text style={s.small}>Now: left {levels[0]}% - front {levels[1]}% - right {levels[2]}%</Text>

            <Text style={s.dStep}>
              Each side shows how close something is (0% = clear, higher = closer). Lower alarm % = warns earlier (from
              farther away). 1) Point the camera at a clear view and press Clear view. 2) Stand where the warning should
              start and press Set alarm here.
            </Text>
            <View style={s.row}>
              <Pressable style={[s.chip, state !== 'live' && s.disabled]} onPress={clearView} disabled={state !== 'live'}>
                <Text style={s.btnText}>Clear view</Text>
              </Pressable>
              <Pressable style={[s.chip, state !== 'live' && s.disabled]} onPress={useCurrent} disabled={state !== 'live'}>
                <Text style={s.btnText}>Set alarm here</Text>
              </Pressable>
            </View>
            {state !== 'live' ? <Text style={s.small}>These need a live picture.</Text> : null}
            {calMsg ? <Text style={s.label}>{calMsg}</Text> : null}

            <Text style={s.label}>Picture size (smaller = smoother video)</Text>
            <View style={s.row}>
              {(
                [
                  ['small', 'Small (fastest)'],
                  ['medium', 'Medium'],
                  ['large', 'Large'],
                ] as [PicSize, string][]
              ).map(([v, label]) => (
                <Pressable key={v} style={[s.chip, size === v && s.chipOn]} onPress={() => changeSize(v)}>
                  <Text style={s.btnText}>{label}</Text>
                </Pressable>
              ))}
            </View>
            {res ? <Text style={s.small}>Camera is sending {res}</Text> : null}

            <View style={s.switchRow}>
              <Text style={s.label}>Mirror picture (fix left/right)</Text>
              <Switch value={flip} onValueChange={toggleFlip} />
            </View>
            <View style={s.row}>
              <Pressable style={s.chip} onPress={testVoice}>
                <Text style={s.btnText}>Test sound</Text>
              </Pressable>
              <Pressable style={s.chip} onPress={rotate}>
                <Text style={s.btnText}>Turn picture {rot}</Text>
              </Pressable>
            </View>
            {voiceMsg ? <Text style={s.label}>{voiceMsg}</Text> : null}

            <Text style={s.section}>Advanced</Text>
            {avoid && dbg ? <Text style={s.small}>Change L/F/R: {dbg}</Text> : null}
            <Pressable style={[s.testBtn, state !== 'live' && s.disabled]} onPress={runTest} disabled={state !== 'live'}>
              <Text style={s.btnText}>Run speed test (about 30 s)</Text>
            </Pressable>
            {state !== 'live' ? <Text style={s.small}>The speed test needs a live picture.</Text> : null}
            <Pressable style={s.testBtn} onPress={shareLog}>
              <Text style={s.btnText}>Share diagnostics</Text>
            </Pressable>

            <Pressable style={s.dBtn} onPress={() => setShowSettings(false)}>
              <Text style={s.btnText}>Done</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg, padding: 10, gap: 10 },
  viewer: { flex: 1, backgroundColor: '#000', borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  web: { flex: 1, backgroundColor: '#000' },
  side: { width: 200, gap: 12, justifyContent: 'center' },
  zones: { ...StyleSheet.absoluteFill, flexDirection: 'row' },
  zone: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 8, gap: 2 },
  meter: { width: 14, height: '45%', borderRadius: 7, backgroundColor: 'rgba(0,0,0,0.5)', overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  meterFill: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  meterMark: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: '#fff' },
  zonePct: { fontSize: 18, fontWeight: '900', textShadowColor: '#000', textShadowRadius: 3 },
  zoneBad: { backgroundColor: 'rgba(239,68,68,0.35)' },
  slowPill: { position: 'absolute', top: 8, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5 },
  slowText: { color: '#fbbf24', fontSize: 12, fontWeight: '700' },
  zoneText: { color: '#fff', fontWeight: '800', textShadowColor: '#000', textShadowRadius: 3 },
  stoppedBox: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  stoppedText: { color: colors.dim, fontSize: 15 },
  status: { fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10 },
  input: { flex: 1, backgroundColor: colors.panel, color: colors.text, borderRadius: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border },
  btn: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 22, justifyContent: 'center', height: 44 },
  btnStop: { backgroundColor: colors.bad },
  btnText: { color: '#fff', fontWeight: '700' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: colors.dim },
  small: { color: colors.dim, fontSize: 11 },
  section: { color: colors.text, fontWeight: '700', marginTop: 6 },
  chip: { flex: 1, backgroundColor: colors.border, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  chipOn: { backgroundColor: colors.accent },
  testBtn: { backgroundColor: colors.border, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  settings: { alignSelf: 'center', width: 440, maxHeight: '100%' },
  stepBtn: { width: 48, backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  distText: { color: colors.text, fontSize: 20, fontWeight: '700', minWidth: 90, textAlign: 'center', alignSelf: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  dialog: { backgroundColor: colors.panel, borderRadius: 14, padding: 20, borderWidth: 1, borderColor: colors.border },
  dTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  dStep: { color: colors.dim, lineHeight: 20 },
  dBtn: { backgroundColor: colors.accent, borderRadius: 8, padding: 12, alignItems: 'center' },
});
