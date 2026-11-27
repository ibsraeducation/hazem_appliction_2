import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export type Phase = { i: number; n: number; ms: number; label: string };

type Props = {
  /** true while we are waiting for frames */
  visible: boolean;
  /** true when a picture was already shown and we are only reconnecting */
  reconnecting: boolean;
  /** current step reported by the viewer (null before the viewer starts) */
  phase: Phase | null;
  /** text shown before the viewer reports phases (e.g. "Joining camera Wi-Fi...") */
  step: string;
  /** changes every time a fresh connection attempt starts (resets the bar) */
  attempt: number;
  onCancel: () => void;
};

/**
 * Covers the screen until real frames arrive.
 * Progress = finished steps + a smooth curve inside the current step, so it always moves,
 * never goes backwards, and only reaches 100 % when a picture is actually on screen.
 */
export default function LoadingOverlay({ visible, reconnecting, phase, step, attempt, onCancel }: Props) {
  const spin = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const [pct, setPct] = useState(0);
  const [left, setLeft] = useState(0);
  const [mounted, setMounted] = useState(visible);
  const phaseAt = useRef(Date.now());
  const floor = useRef(0); // progress never goes below this

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  useEffect(() => {
    floor.current = 0;
    setPct(0);
  }, [attempt]);
  useEffect(() => {
    phaseAt.current = Date.now();
  }, [phase]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      fade.setValue(1);
      const t = setInterval(() => {
        const elapsed = Date.now() - phaseAt.current;
        let p: number;
        let secs: number;
        if (phase) {
          const share = 100 / Math.max(1, phase.n);
          const start = (phase.i / Math.max(1, phase.n)) * 100;
          // ease towards the end of this step; ~86 % of the step after its timeout
          p = start + share * (1 - Math.exp((-2 * elapsed) / phase.ms));
          secs = Math.ceil(Math.max(0, phase.ms - elapsed) / 1000);
        } else {
          p = 8 * (1 - Math.exp(-elapsed / 4000)); // before the viewer starts (joining Wi-Fi)
          secs = 0;
        }
        floor.current = Math.min(97, Math.max(floor.current + 0.05, p)); // always creeps forward
        setPct(Math.round(floor.current));
        setLeft(secs);
      }, 100);
      return () => clearInterval(t);
    }
    // Frames are here: 100 %, then fade out.
    setPct(100);
    Animated.timing(fade, { toValue: 0, duration: 350, delay: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, phase, fade]);

  if (!mounted) return null;
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const label = phase?.label ?? step;

  if (reconnecting) {
    return (
      <Animated.View style={[s.pill, { opacity: fade }]} pointerEvents="none">
        <Animated.View style={[s.ringSmall, { transform: [{ rotate }] }]} />
        <Text style={s.pillText}>Reconnecting...</Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[s.root, { opacity: fade }]} pointerEvents={visible ? 'auto' : 'none'}>
      <Animated.View style={[s.ring, { transform: [{ rotate }] }]} />
      <Text style={s.title}>Connecting to camera</Text>
      <View style={s.bar}>
        <View style={[s.fill, { width: `${pct}%` }]} />
      </View>
      <Text style={s.pct}>
        {pct}%{left > 0 ? `  -  this step up to ${left} s` : ''}
      </Text>
      {label ? <Text style={s.step}>{label}</Text> : null}
      <Pressable style={({ pressed }) => [s.cancel, pressed && { opacity: 0.7 }]} onPress={onCancel}>
        <Text style={s.cancelText}>Cancel</Text>
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 14 },
  ring: { width: 56, height: 56, borderRadius: 28, borderWidth: 5, borderColor: colors.border, borderTopColor: colors.accent },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  bar: { width: 280, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.accent },
  pct: { color: colors.dim, fontSize: 14, fontVariant: ['tabular-nums'] },
  step: { color: colors.text, fontSize: 14 },
  cancel: { marginTop: 6, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.dim, fontWeight: '700' },
  pill: {
    position: 'absolute',
    top: 16,
    alignSelf: 'center',
    left: 0,
    right: 0,
    marginHorizontal: 'auto',
    width: 190,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(11,13,16,0.85)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ringSmall: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: colors.border, borderTopColor: colors.accent },
  pillText: { color: colors.text, fontWeight: '700' },
});
