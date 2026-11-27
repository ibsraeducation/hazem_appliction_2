import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import type { PicSize } from '../lib/viewerHtml';
import { bestSize, findings, fpsLevel, SIZE_NAME, type Level, type TestResult } from '../lib/speedTest';

type Props = {
  result: TestResult;
  onUse: (size: PicSize) => void;
  onShare: () => void;
  onClose: () => void;
};

const dot: Record<Level, string> = { good: colors.ok, warn: '#f59e0b', bad: colors.bad };

/** Full-screen speed test results: one row per step and a plain "what to fix" list. */
export default function TestResults({ result, onUse, onShare, onClose }: Props) {
  const best = bestSize(result);
  const list = findings(result);
  const rows: { name: string; level: Level; main: string; info: string }[] = [];
  if (result.ping) {
    const p = result.ping;
    rows.push({
      name: 'Connection',
      level: p.miss >= 3 ? 'bad' : p.avg > 300 || p.miss ? 'warn' : 'good',
      main: `${p.avg} ms`,
      info: `worst ${p.worst} ms, ${p.miss} of 5 missed`,
    });
  }
  for (const v of result.video) {
    rows.push({
      name: `Video ${SIZE_NAME[v.size]}`,
      level: v.ok ? fpsLevel(v.fps) : 'bad',
      main: v.ok ? `${v.fps} fps` : 'failed',
      info: v.ok
        ? `${v.w}x${v.h} - ${v.kb ?? '-'} kB per picture - ${v.kbps ?? '-'} kB/s - longest pause ${v.gap} ms`
        : (v.err ?? ''),
    });
  }
  if (result.photo) {
    const p = result.photo;
    rows.push({
      name: 'Photo mode',
      level: p.ok ? fpsLevel(p.fps) : 'bad',
      main: p.ok ? `${p.fps} fps` : 'failed',
      info: p.ok ? `${p.w}x${p.h}` : (p.err ?? ''),
    });
  }

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.title}>Speed test results</Text>
        <View style={s.cols}>
          <View style={s.col}>
            {rows.map((r) => (
              <View key={r.name} style={s.row}>
                <View style={[s.dot, { backgroundColor: dot[r.level] }]} />
                <Text style={s.name}>{r.name}</Text>
                <Text style={[s.main, { color: dot[r.level] }]}>{r.main}</Text>
                <Text style={s.info}>{r.info}</Text>
              </View>
            ))}
          </View>
          <View style={s.col}>
            <Text style={s.section}>What to fix</Text>
            {list.map((f, i) => (
              <View key={i} style={s.fix}>
                <View style={[s.dot, { backgroundColor: dot[f.level] }]} />
                <Text style={s.fixText}>{f.text}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={s.actions}>
          {best && (
            <Pressable style={({ pressed }) => [s.primary, pressed && s.pressed]} onPress={() => onUse(best.size)}>
              <Text style={s.primaryText}>
                Use best setting ({SIZE_NAME[best.size]}, {best.fps} fps)
              </Text>
            </Pressable>
          )}
          <Pressable style={({ pressed }) => [s.secondary, pressed && s.pressed]} onPress={onShare}>
            <Text style={s.secondaryText}>Share report</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [s.secondary, pressed && s.pressed]} onPress={onClose}>
            <Text style={s.secondaryText}>Close</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg },
  body: { padding: 20, gap: 14 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  cols: { flexDirection: 'row', gap: 20, flexWrap: 'wrap' },
  col: { flex: 1, minWidth: 280, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border },
  dot: { width: 12, height: 12, borderRadius: 6 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700', width: 120 },
  main: { fontSize: 16, fontWeight: '800', width: 80 },
  info: { color: colors.dim, fontSize: 12, flexBasis: '100%', marginLeft: 20 },
  section: { color: colors.text, fontSize: 16, fontWeight: '800' },
  fix: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  fixText: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 22, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secondary: { borderColor: colors.border, borderWidth: 2, borderRadius: 10, paddingHorizontal: 22, paddingVertical: 12, alignItems: 'center' },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
