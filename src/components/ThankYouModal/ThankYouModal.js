import { useCallback, useEffect } from "react";
import { FaGithub } from "react-icons/fa";

export default function ThankYouModal({isModalOpen, setModalIsOpen}) {
  if (!isModalOpen) return null;

  const escFunction = useCallback((event) => {
    if (event.key === "Escape") {
      setModalIsOpen(false)
    }
  }, [setModalIsOpen]);

  useEffect(() => {
    document.addEventListener("keydown", escFunction, false);

    return () => {
      document.removeEventListener("keydown", escFunction, false);
    };
  }, [escFunction]);

  return (
    <div className="fixed inset-0 z-999 flex items-center justify-center backdrop-blur-xs bg-opacity-40">
      <div className="bg-white max-w-md w-full p-6 rounded-2xl shadow-lg relative">
        <br/><br/>
        <div className="text-gray-700 space-y-3">
          <p>
            <a href="https://github.com/TheMrBooblik/sleeper-train-map" rel="noreferrer" target="_blank" className="flex items-center justify-center gap-2">
              <span><FaGithub/></span>
              <span>Github link</span>
            </a>
          </p><br/>
          <p className="text-center">
            Huge thanks to&nbsp;
            <a
              href="https://back-on-track.eu"
              target="_blank"
              rel="noopener noreferrer"
              className="!text-blue-900 underline hover:text-blue-700"
            >
              Back-on-Track.eu
            </a> for providing data!
          </p>
          <br/>
        </div>

        <div className="mt-6 text-right">
          <button
            onClick={() => setModalIsOpen(false)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}