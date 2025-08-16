import Link from "next/link";

export default function NotFound() {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-gray-800 mb-4">Conversation Not Found</h2>
        <p className="text-gray-600 mb-6">The conversation you&apos;re looking for doesn&apos;t exist.</p>
        <Link 
          href="/"
          className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors inline-block"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
