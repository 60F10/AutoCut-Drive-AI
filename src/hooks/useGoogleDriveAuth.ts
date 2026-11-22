import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  initGoogleAuth,
  signInWithGoogleDrive,
  signOutGoogleDrive,
} from '../services/googleAuth';
import { checkServerHealth } from '../services/geminiClient';

interface UseGoogleDriveAuthOptions {
  onError: (message: string | null) => void;
}

export function useGoogleDriveAuth({ onError }: UseGoogleDriveAuthOptions) {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(true);

  useEffect(() => {
    const unsubscribe = initGoogleAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setAccessToken(token);
      },
      () => {
        setUser(null);
        setAccessToken(null);
      }
    );

    checkServerHealth().then((health) => {
      setGeminiConfigured(health.geminiConfigured);
    });

    return unsubscribe;
  }, []);

  const clearAuthSession = useCallback(() => {
    setUser(null);
    setAccessToken(null);
  }, []);

  const handleGoogleLogin = useCallback(async () => {
    onError(null);
    setIsLoggingIn(true);
    try {
      const session = await signInWithGoogleDrive();
      setUser(session.user);
      setAccessToken(session.accessToken);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'No se pudo iniciar sesión con Google Drive.';
      onError(message);
    } finally {
      setIsLoggingIn(false);
    }
  }, [onError]);

  const handleGoogleLogout = useCallback(async () => {
    await signOutGoogleDrive();
    setUser(null);
    setAccessToken(null);
  }, []);

  return {
    user,
    accessToken,
    isLoggingIn,
    geminiConfigured,
    isDriveConnected: Boolean(user && accessToken),
    handleGoogleLogin,
    handleGoogleLogout,
    clearAuthSession,
  };
}
