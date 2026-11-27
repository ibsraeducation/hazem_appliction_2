import { requireOptionalNativeModule } from 'expo';

type WifiLockNative = { acquire(): boolean; release(): void };

// null in Expo Go / iOS: the app then simply works without the lock.
export default requireOptionalNativeModule<WifiLockNative>('WifiLock');
