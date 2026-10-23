import { ChatScreen } from "@/components/ChatScreen";

export default async function ChatById({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatScreen chatId={id} />;
}
