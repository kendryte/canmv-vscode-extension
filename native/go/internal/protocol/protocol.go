package protocol

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

var Magic = [2]byte{'C', 'M'}

const (
	MsgRequest  byte = 0x01
	MsgResponse byte = 0x02
	MsgEvent    byte = 0x03
	MsgFrame    byte = 0x04

	headerSize     = 7
	maxPayloadSize = 64 * 1024 * 1024
)

type Request struct {
	ID     int                    `json:"id"`
	Method string                 `json:"method"`
	Params map[string]interface{} `json:"params"`
}

type Response struct {
	ID     int         `json:"id"`
	Result interface{} `json:"result,omitempty"`
	Error  *Error      `json:"error,omitempty"`
}

type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Event struct {
	Event  string      `json:"event"`
	Params interface{} `json:"params"`
}

type Conn struct {
	r  *bufio.Reader
	w  io.Writer
	mu sync.Mutex
}

func NewConn(r io.Reader, w io.Writer) *Conn {
	return &Conn{
		r: bufio.NewReaderSize(r, 64*1024),
		w: w,
	}
}

func (c *Conn) ReadRequest() (Request, error) {
	for {
		msgType, payload, err := c.readFrame()
		if err != nil {
			return Request{}, err
		}
		if msgType != MsgRequest {
			continue
		}
		var req Request
		if err := json.Unmarshal(payload, &req); err != nil {
			return Request{}, err
		}
		if req.Params == nil {
			req.Params = map[string]interface{}{}
		}
		return req, nil
	}
}

func (c *Conn) Respond(id int, result interface{}) error {
	return c.writeJSON(MsgResponse, Response{ID: id, Result: result})
}

func (c *Conn) RespondError(id int, code int, message string) error {
	return c.writeJSON(MsgResponse, Response{ID: id, Error: &Error{Code: code, Message: message}})
}

func (c *Conn) Event(name string, params interface{}) error {
	return c.writeJSON(MsgEvent, Event{Event: name, Params: params})
}

func (c *Conn) Frame(frameID uint32, jpeg []byte) error {
	payloadLen := 4 + len(jpeg)
	prefix := make([]byte, headerSize+4)
	prefix[0], prefix[1], prefix[2] = Magic[0], Magic[1], MsgFrame
	binary.LittleEndian.PutUint32(prefix[3:], uint32(payloadLen))
	binary.LittleEndian.PutUint32(prefix[headerSize:], frameID)

	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.w.Write(prefix); err != nil {
		return err
	}
	_, err := c.w.Write(jpeg)
	return err
}

func (c *Conn) writeJSON(msgType byte, value interface{}) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.writeFrame(msgType, payload)
}

func (c *Conn) writeFrame(msgType byte, payload []byte) error {
	header := make([]byte, headerSize)
	header[0], header[1], header[2] = Magic[0], Magic[1], msgType
	binary.LittleEndian.PutUint32(header[3:], uint32(len(payload)))

	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.w.Write(header); err != nil {
		return err
	}
	_, err := c.w.Write(payload)
	return err
}

func (c *Conn) readFrame() (byte, []byte, error) {
	header := make([]byte, headerSize)
	if _, err := io.ReadFull(c.r, header); err != nil {
		return 0, nil, err
	}
	if header[0] != Magic[0] || header[1] != Magic[1] {
		return 0, nil, errors.New("bad frame magic")
	}
	payloadLen := binary.LittleEndian.Uint32(header[3:])
	if payloadLen > maxPayloadSize {
		return 0, nil, fmt.Errorf("payload too large: %d", payloadLen)
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(c.r, payload); err != nil {
		return 0, nil, err
	}
	return header[2], payload, nil
}
