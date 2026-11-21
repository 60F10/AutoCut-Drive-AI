import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'] as const;

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of DRIVE_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

// Strict in-memory OAuth access token cache (never persisted in localStorage/sessionStorage)
let cachedAccessToken: string | null = null;
let isSigningIn = false;

export interface AuthSession {
  user: User;
  accessToken: string;
}

export function initGoogleAuth(
  onAuthenticated: (user: User, token: string) => void,
  onUnauthenticated: () => void
): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (user && cachedAccessToken) {
      onAuthenticated(user, cachedAccessToken);
    } else if (!isSigningIn) {
      cachedAccessToken = null;
      onUnauthenticated();
    }
  });
}

export async function signInWithGoogleDrive(): Promise<AuthSession> {
  isSigningIn = true;
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('No se obtuvo el token de acceso de Google Drive.');
    }
    cachedAccessToken = credential.accessToken;
    return {
      user: result.user,
      accessToken: cachedAccessToken,
    };
  } finally {
    isSigningIn = false;
  }
}

export function getCachedDriveToken(): string | null {
  return cachedAccessToken;
}

export async function signOutGoogleDrive(): Promise<void> {
  cachedAccessToken = null;
  await auth.signOut();
}
