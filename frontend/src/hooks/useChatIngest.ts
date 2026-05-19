'use client';

import { useCallback, useState } from 'react';
import { postChatIngest } from '@/lib/api';
import type { ChatIngestResponse } from '@/lib/types';

interface UseChatIngestResult {
  submit: (text: string) => Promise<ChatIngestResponse>;
  isPending: boolean;
  error: string | null;
}

export function useChatIngest(
  onSuccess?: (response: ChatIngestResponse) => void,
): UseChatIngestResult {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (text: string): Promise<ChatIngestResponse> => {
      setIsPending(true);
      setError(null);
      try {
        const response = await postChatIngest(text);
        onSuccess?.(response);
        return response;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    [onSuccess],
  );

  return { submit, isPending, error };
}
