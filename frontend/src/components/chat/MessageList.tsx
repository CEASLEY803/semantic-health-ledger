'use client';

import ChatBubble from './ChatBubble';
import type { ChatMessage } from '@/lib/types';

interface MessageListProps {
  messages: ChatMessage[];
}

export default function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <p className="mt-8 text-center text-xs text-gray-600">
        Send a message to log vitals, labs, compounds, or journal entries.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {messages.map((msg) => (
        <li key={msg.id}>
          <ChatBubble message={msg} />
        </li>
      ))}
    </ul>
  );
}
