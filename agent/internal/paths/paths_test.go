package paths

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEnsureDataDirKeepsTheParentReachable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix modes")
	}
	root := t.TempDir()
	parent := filepath.Join(root, "Regimen")
	t.Setenv("REGIMEN_DATA", filepath.Join(parent, "data"))
	if err := WriteJSON("config.json", Config{}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(parent)
	if st.Mode().Perm()&0o055 != 0o055 {
		t.Fatalf("parent must stay readable by others (it holds the program on macOS), mode %v", st.Mode())
	}
	st, _ = os.Stat(DataDir())
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("data folder must be private, mode %v", st.Mode())
	}
	if FallbackBinary() != filepath.Join(DataDir(), BinaryName()) {
		t.Fatal("fallback binary lives in the data folder")
	}
	if OwnParent() != "" {
		t.Fatal("no own parent when REGIMEN_DATA overrides the location")
	}
}
