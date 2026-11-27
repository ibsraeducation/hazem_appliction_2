import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import LiveScreen from './src/screens/LiveScreen';
import { colors } from './src/theme';

// Shows a restart button instead of a blank screen if something unexpected breaks.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean; key: number }> {
  state = { failed: false, key: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <View style={s.root}>
          <Text style={s.title}>Something went wrong</Text>
          <Pressable style={s.btn} onPress={() => this.setState((st) => ({ failed: false, key: st.key + 1 }))}>
            <Text style={s.btnText}>Restart</Text>
          </Pressable>
        </View>
      );
    }
    return <React.Fragment key={this.state.key}>{this.props.children}</React.Fragment>;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <StatusBar style="light" hidden />
      <LiveScreen />
    </ErrorBoundary>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  btn: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 24, paddingVertical: 12 },
  btnText: { color: '#fff', fontWeight: '700' },
});
