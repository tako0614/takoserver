//go:build !linux || !amd64

package guard

// Run fails explicitly on platforms where the native process and timer
// guarantees are not implemented.
func Run(_ Options) error {
	return guardError(CodeUnsupported, errUnsupported)
}
