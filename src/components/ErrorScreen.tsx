import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import type { Action, Help } from '../lib/errorHelp';

type Props = {
  help: Help;
  onAction: (a: Action) => void;
};

/** Full-screen error: what happened, why, numbered steps and big clear buttons. */
export default function ErrorScreen({ help, onAction }: Props) {
  const [left, setLeft] = useState(help.autoRetry ?? 0);

  // Optional automatic retry countdown (only for errors where waiting can help).
  useEffect(() => {
    setLeft(help.autoRetry ?? 0);
  }, [help]);
  useEffect(() => {
    if (!left) return;
    const t = setTimeout(() => (left === 1 ? onAction('retry') : setLeft(left - 1)), 1000);
    return () => clearTimeout(t);
  }, [left, onAction]);

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={s.body}>
        <View style={s.icon}>
          <Text style={s.iconText}>!</Text>
        </View>
        <Text style={s.title}>{help.title}</Text>
        <Text style={s.reason}>{help.reason}</Text>
        <View style={s.steps}>
          {help.steps.map((t, i) => (
            <View key={i} style={s.stepRow}>
              <Text style={s.stepNum}>{i + 1}</Text>
              <Text style={s.stepText}>{t}</Text>
            </View>
          ))}
        </View>
        <View style={s.actions}>
          <Pressable style={({ pressed }) => [s.primary, pressed && s.pressed]} onPress={() => onAction(help.primary.action)}>
            <Text style={s.primaryText}>
              {help.primary.label}
              {left ? ` (${left})` : ''}
            </Text>
          </Pressable>
          {help.secondary && (
            <Pressable
              style={({ pressed }) => [s.secondary, pressed && s.pressed]}
              onPress={() => onAction(help.secondary!.action)}
            >
              <Text style={s.secondaryText}>{help.secondary.label}</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg },
  body: { alignItems: 'center', padding: 24, gap: 12 },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderWidth: 2,
    borderColor: colors.bad,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: colors.bad, fontSize: 28, fontWeight: '800' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  reason: { color: colors.dim, fontSize: 15, textAlign: 'center', maxWidth: 560 },
  steps: { gap: 8, maxWidth: 560, alignSelf: 'center', marginTop: 4 },
  stepRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  stepNum: {
    color: '#fff',
    backgroundColor: colors.accent,
    width: 22,
    height: 22,
    borderRadius: 11,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: 12,
    fontWeight: '800',
    overflow: 'hidden',
  },
  stepText: { color: colors.text, fontSize: 15, flex: 1, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 28, paddingVertical: 14, minWidth: 200, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  secondary: { borderColor: colors.border, borderWidth: 2, borderRadius: 10, paddingHorizontal: 28, paddingVertical: 12, minWidth: 200, alignItems: 'center' },
  secondaryText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
