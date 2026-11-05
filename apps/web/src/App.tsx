import { Link, Route, Routes } from "react-router";
import { UploadDetailPage } from "./pages/UploadDetailPage.js";
import { UploadsPage } from "./pages/UploadsPage.js";

export function App() {
  return (
    <div className="layout">
      <header>
        <Link to="/" className="brand">
          VR UPM Server
        </Link>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<UploadsPage />} />
          <Route path="/uploads/:id" element={<UploadDetailPage />} />
          <Route path="*" element={<p>ページが見つかりません。 <Link to="/">Upload 一覧へ</Link></p>} />
        </Routes>
      </main>
    </div>
  );
}
